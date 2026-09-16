const express = require('express');
const axios = require('axios');
const path = require('path');
const Afip = require('@afipsdk/afip.js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLAVE_SECRETA = process.env.APP_PASSWORD || "miclave123";

// Inicializamos conexión con Web Service de ARCA / AFIP
// En dev consulta con el CUIT homologado habilitado para el padrón
const afip = new Afip({
    CUIT: 20409378472,
    production: false
});

function calcularCUIT(dni, genero) {
    const dniStr = dni.toString().padStart(8, '0');
    let prefijo = genero === 'M' ? '20' : (genero === 'F' ? '27' : '20');
    
    function obtenerDigito(pref, num) {
        const coef = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
        const cadena = pref + num;
        let suma = 0;
        for (let i = 0; i < 10; i++) suma += parseInt(cadena[i]) * coef[i];
        const resto = suma % 11;
        if (resto === 0) return 0;
        if (resto === 1) return null;
        return 11 - resto;
    }

    let digito = obtenerDigito(prefijo, dniStr);
    if (digito === null) {
        prefijo = '23';
        digito = obtenerDigito(prefijo, dniStr);
    }
    return `${prefijo}${dniStr}${digito}`;
}

// Consulta a ARCA (ex-AFIP)
async function consultarARCA(cuit) {
    try {
        const info = await afip.RegisterInscriptionProofService.getTaxpayerDetails(cuit);
        if (!info) {
            return { estado: 'NO_INSCRIPTO', detalle: 'No figura inscripto en el padrón de ARCA' };
        }

        const datosGenerales = info.datosGenerales || {};
        const datosMonotributo = info.datosMonotributo;
        const impuestos = info.impuesto || [];

        let tipoInscripcion = 'No registra impuestos activos';
        let categoriaMonotributo = null;

        if (datosMonotributo && datosMonotributo.categoriaMonotributo) {
            tipoInscripcion = 'Monotributo';
            categoriaMonotributo = datosMonotributo.categoriaMonotributo.descripcionCategoria || 'Activo';
        } else if (Array.isArray(impuestos) && impuestos.length > 0) {
            const tieneIVA = impuestos.some(imp => (imp.descripcionImpuesto || '').toLowerCase().includes('iva'));
            tipoInscripcion = tieneIVA ? 'Responsable Inscripto' : 'Inscripto en Impuestos';
        }

        return {
            estado: 'INSCRIPTO',
            tipo: tipoInscripcion,
            categoria: categoriaMonotributo,
            nombre: datosGenerales.nombre ? `${datosGenerales.apellido || ''} ${datosGenerales.nombre}`.trim() : (datosGenerales.razonSocial || null),
            estadoClave: datosGenerales.estadoClave || 'ACTIVO'
        };
    } catch (e) {
        // Si el CUIT no existe en el registro impositivo o está inactivo
        return {
            estado: 'SIN_IMPUESTOS',
            tipo: 'No figura inscripto o sin impuestos activos',
            detalle: e.message || ''
        };
    }
}

// Consulta al BCRA
async function consultarBCRA(cuit) {
    let denominacion = null;
    let registros = [];

    try {
        const res = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${cuit}`, {
            headers: { 'Accept': 'application/json' },
            timeout: 6000
        });

        if (res.data && res.data.results) {
            denominacion = res.data.results.denominacion || null;
            const periodos = res.data.results.periodos || [];
            for (const p of periodos) {
                if (p.entidades) {
                    for (const ent of p.entidades) {
                        registros.push({
                            periodo: p.periodo,
                            entidad: ent.entidad,
                            situacion: ent.situacion,
                            monto: ent.monto
                        });
                    }
                }
            }
        }
    } catch (e) {}

    // Si no trajo nombre o deudas vigentes, revisa historial
    if (registros.length === 0 || !denominacion) {
        try {
            const resHist = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/Historicas/${cuit}`, {
                headers: { 'Accept': 'application/json' },
                timeout: 6000
            });
            if (resHist.data && resHist.data.results) {
                denominacion = resHist.data.results.denominacion || denominacion;
                const periodos = resHist.data.results.periodos || [];
                if (registros.length === 0 && periodos.length > 0) {
                    const ult = periodos[0];
                    if (ult.entidades) {
                        for (const ent of ult.entidades) {
                            registros.push({
                                periodo: ult.periodo,
                                entidad: ent.entidad,
                                situacion: ent.situacion,
                                monto: ent.monto,
                                historico: true
                            });
                        }
                    }
                }
            }
        } catch (e) {}
    }

    return { denominacion, registros };
}

app.post('/api/consultar', async (req, res) => {
    const { dni, genero, password } = req.body;

    if (password !== CLAVE_SECRETA) {
        return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }

    if (!dni || isNaN(dni)) {
        return res.status(400).json({ error: 'DNI inválido.' });
    }

    let cuits = [];
    if (genero === 'M' || genero === 'F') {
        cuits.push({ genero: genero === 'M' ? 'Masculino' : 'Femenino', cuit: calcularCUIT(dni, genero) });
    } else {
        cuits.push({ genero: 'Masculino', cuit: calcularCUIT(dni, 'M') });
        cuits.push({ genero: 'Femenino', cuit: calcularCUIT(dni, 'F') });
    }

    const reportes = [];

    for (const item of cuits) {
        // Ejecutamos ambas consultas en paralelo para máxima velocidad
        const [bcra, arca] = await Promise.all([
            consultarBCRA(item.cuit),
            consultarARCA(item.cuit)
        ]);

        const nombreFinal = arca.nombre || bcra.denominacion || 'Nombre no registrado';

        reportes.push({
            genero: item.genero,
            cuit: item.cuit,
            nombre: nombreFinal,
            arca: arca,
            bcra: bcra
        });
    }

    res.json({ dni, reportes });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Iniciado en puerto ${PORT}`));

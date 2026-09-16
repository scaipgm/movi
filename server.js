const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLAVE_SECRETA = process.env.APP_PASSWORD || "miclave123";

// 1. Cálculo de CUIT / CUIL oficial (Módulo 11)
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

// 2. Consulta al BCRA (Central de Deudores)
async function consultarBCRA(cuit) {
    let denominacion = null;
    let registros = [];

    // Intento 1: Deudas Actuales
    try {
        const res = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${cuit}`, {
            headers: { 'Accept': 'application/json' },
            timeout: 5000
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

    // Intento 2: Histórico (últimos 24 meses) si no trajo denominación o deuda activa
    if (registros.length === 0 || !denominacion) {
        try {
            const resHist = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/Historicas/${cuit}`, {
                headers: { 'Accept': 'application/json' },
                timeout: 5000
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

// Endpoint de consulta de persona
app.post('/api/consultar', async (req, res) => {
    const { dni, genero, password } = req.body;

    if (password !== CLAVE_SECRETA) {
        return res.status(401).json({ error: 'Contraseña de acceso incorrecta.' });
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
        const bcra = await consultarBCRA(item.cuit);
        reportes.push({
            genero: item.genero,
            cuit: item.cuit,
            denominacion: bcra.denominacion,
            bcra: bcra
        });
    }

    res.json({ dni, reportes });
});

// Endpoint de consulta de BIN / Banco de Tarjeta
app.get('/api/bin/:bin', async (req, res) => {
    const { bin } = req.params;
    try {
        const response = await axios.get(`https://data.handyapi.com/bin/${bin}`, { timeout: 4000 });
        if (response.data && response.data.Status === 'SUCCESS') {
            return res.json({
                valido: true,
                banco: response.data.Issuer || 'No identificado',
                marca: response.data.Scheme || 'Desconocida',
                tipo: response.data.Type || 'Crédito/Débito',
                pais: response.data.Country ? response.data.Country.Name : 'Desconocido'
            });
        }
        res.json({ valido: false, banco: 'Banco no identificado' });
    } catch (e) {
        res.json({ valido: false, banco: 'Banco no disponible' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));

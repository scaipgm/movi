const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLAVE_SECRETA = process.env.APP_PASSWORD || "miclave123";

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

async function consultarBCRA(cuit) {
    // 1. Consulta deuda actual
    let denominacion = null;
    let registros = [];

    try {
        const resActual = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${cuit}`, {
            headers: { 'Accept': 'application/json' },
            timeout: 7000
        });

        if (resActual.data && resActual.data.results) {
            denominacion = resActual.data.results.denominacion || denominacion;
            const periodos = resActual.data.results.periodos || [];
            for (const p of periodos) {
                if (p.entidades) {
                    for (const ent of p.entidades) {
                        registros.push({
                            periodo: p.periodo,
                            entidad: ent.entidad,
                            situacion: ent.situacion,
                            monto: ent.monto,
                            diasAtraso: ent.diasAtrasoPago || 0
                        });
                    }
                }
            }
        }
    } catch (e) {
        // Ignorar 404
    }

    // 2. Si no hay denominación o no hay deudas vigentes, consultar Históricas (últimos 24 meses)
    if (registros.length === 0 || !denominacion) {
        try {
            const resHist = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/Historicas/${cuit}`, {
                headers: { 'Accept': 'application/json' },
                timeout: 7000
            });

            if (resHist.data && resHist.data.results) {
                denominacion = resHist.data.results.denominacion || denominacion;
                const periodos = resHist.data.results.periodos || [];
                // Si aún no tenemos registros, extraemos los últimos históricos reportados
                if (registros.length === 0 && periodos.length > 0) {
                    const ultPeriodo = periodos[0];
                    if (ultPeriodo.entidades) {
                        for (const ent of ultPeriodo.entidades) {
                            registros.push({
                                periodo: ultPeriodo.periodo,
                                entidad: ent.entidad,
                                situacion: ent.situacion,
                                monto: ent.monto,
                                diasAtraso: ent.diasAtrasoPago || 0,
                                historico: true
                            });
                        }
                    }
                }
            }
        } catch (e) {
            // Ignorar 404
        }
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
        const resultadoBCRA = await consultarBCRA(item.cuit);
        reportes.push({
            genero: item.genero,
            cuit: item.cuit,
            denominacion: resultadoBCRA.denominacion,
            registros: resultadoBCRA.registros
        });
    }

    res.json({ dni, reportes });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Puerto ${PORT}`));

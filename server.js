const express = require('express');
const axios = require('axios');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLAVE_SECRETA = process.env.APP_PASSWORD || "tarde";

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

// Algoritmo oficial de CUIT / CUIL (Módulo 11)
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

function parsearPeriodos(periodos) {
    const registros = [];
    if (!Array.isArray(periodos)) return registros;

    for (const p of periodos) {
        const entidades = p.entidades || p.deudas || [];
        for (const ent of entidades) {
            registros.push({
                periodo: p.periodo || 'Reciente',
                entidad: ent.entidad || ent.denominacion || 'Entidad financiera',
                situacion: parseInt(ent.situacion, 10) || 1,
                monto: ent.monto || 0,
                diasAtraso: ent.diasAtrasoPago || ent.diasAtraso || 0
            });
        }
    }
    return registros;
}

// Consulta interna al BCRA con headers de navegador
async function consultarBCRAInterno(cuit) {
    let denominacion = null;
    let registros = [];

    const config = {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        },
        httpsAgent,
        timeout: 5000
    };

    try {
        const rActual = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${cuit}`, config);
        if (rActual.data && rActual.data.results) {
            denominacion = rActual.data.results.denominacion || null;
            registros = parsearPeriodos(rActual.data.results.periodos);
        }
    } catch (e) {}

    if (registros.length === 0 || !denominacion) {
        try {
            const rHist = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/Historicas/${cuit}`, config);
            if (rHist.data && rHist.data.results) {
                denominacion = rHist.data.results.denominacion || denominacion;
                const ult = parsearPeriodos(rHist.data.results.periodos);
                if (registros.length === 0 && ult.length > 0) {
                    registros = ult.slice(0, 15);
                }
            }
        } catch (e) {}
    }

    return { denominacion, registros };
}

// Endpoint Persona
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
        const datos = await consultarBCRAInterno(item.cuit);
        reportes.push({
            genero: item.genero,
            cuit: item.cuit,
            denominacion: datos.denominacion,
            registros: datos.registros
        });
    }

    res.json({ dni, reportes });
});

// Endpoint Coordenadas exactas para cobertura
app.get('/api/coords', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Dirección requerida' });
    try {
        const query = `${q}, Mendoza, Argentina`;
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=ar&limit=1`;
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'GestionCallMoviApp/2.0' },
            timeout: 5000
        });
        if (response.data && response.data.length > 0) {
            return res.json({
                lat: response.data[0].lat,
                lon: response.data[0].lon,
                display: response.data[0].display_name
            });
        }
        res.json({ error: 'No se encontraron coordenadas' });
    } catch (e) {
        res.status(500).json({ error: 'Error al consultar coordenadas' });
    }
});

// Endpoint Tarjetas BIN
app.get('/api/bin/:bin', async (req, res) => {
    try {
        const response = await axios.get(`https://data.handyapi.com/bin/${req.params.bin}`, { timeout: 4000 });
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
app.listen(PORT, () => console.log(`Puerto ${PORT}`));

const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Clave de acceso establecida
const CLAVE_SECRETA = process.env.APP_PASSWORD || "tarde";

// 1. Algoritmo oficial de CUIT / CUIL (Módulo 11)
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

// 2. Consulta Central de Deudores del BCRA
async function consultarBCRA(cuit) {
    let denominacion = null;
    let registros = [];

    // Consulta deudas del período actual
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

    // Si no trajo nombre o deudas vigentes, revisa historial de los últimos 24 meses
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

// Endpoint de Consulta de Persona
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

// Endpoint Validador de BIN de Tarjetas (identifica banco)
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

// Endpoint Geolocalizador (Dirección a Coordenadas)
app.get('/api/geocode', async (req, res) => {
    const { direccion } = req.query;
    if (!direccion) return res.status(400).json({ error: 'Dirección requerida' });

    try {
        const consulta = `${direccion}, Mendoza, Argentina`;
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(consulta)}&countrycodes=ar&limit=3`;
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'GestionVentasTelecomApp/1.0' },
            timeout: 5000
        });

        if (response.data && response.data.length > 0) {
            const resultados = response.data.map(item => ({
                lat: item.lat,
                lon: item.lon,
                nombre: item.display_name,
                mapsUrl: `https://www.google.com/maps?q=${item.lat},${item.lon}`
            }));
            return res.json({ exito: true, resultados });
        }
        res.json({ exito: false, mensaje: 'No se encontraron coordenadas para esa dirección.' });
    } catch (e) {
        res.status(500).json({ exito: false, mensaje: 'Error al consultar el servicio satelital.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));

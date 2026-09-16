const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CLAVE DE ACCESO: cámbiala por la contraseña que quieras
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

app.post('/api/consultar', async (req, res) => {
    const { dni, genero, password } = req.body;

    // Validación de seguridad privada
    if (password !== CLAVE_SECRETA) {
        return res.status(401).json({ error: 'Contraseña incorrecta. Acceso no autorizado.' });
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
        try {
            const url = `https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${item.cuit}`;
            const bcraRes = await axios.get(url, { 
                headers: { 'Accept': 'application/json' },
                timeout: 5000 
            });
            reportes.push({
                genero: item.genero,
                cuit: item.cuit,
                datosBCRA: bcraRes.data.results || null
            });
        } catch (err) {
            reportes.push({
                genero: item.genero,
                cuit: item.cuit,
                datosBCRA: null,
                nota: 'Sin registros de deuda reportados al BCRA'
            });
        }
    }

    res.json({ dni, reportes });
});

// Render asigna el puerto automáticamente en process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`App activa en el puerto ${PORT}`);
});

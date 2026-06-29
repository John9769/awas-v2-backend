const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));

// Body parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'AWAS V2 Backend',
        version: '2.0.0'
    });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/driver', require('./routes/driver'));
app.use('/api/insurer', require('./routes/insurer'));
app.use('/api/logs', require('./routes/logs'));

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route tidak dijumpai.' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('AWAS V2 Global Error:', err);
    res.status(500).json({ error: 'Ralat pelayan.' });
});

app.listen(PORT, () => {
    console.log(`AWAS V2 Backend listening on port ${PORT}`);

    // Keep-alive ping every 14 minutes to prevent Render cold start
    if (process.env.BE_URL) {
        setInterval(() => {
            try {
                const beUrl = process.env.BE_URL;
                const url = new URL(`${beUrl}/health`);
                const client = url.protocol === 'https:' ? require('https') : require('http');
                const req = client.get(url.href, (res) => {
                    console.log(`AWAS V2: Keep-alive ping OK — ${res.statusCode}`);
                });
                req.on('error', (err) => {
                    console.error('AWAS V2: Keep-alive ping failed —', err.message);
                });
                req.end();
            } catch (err) {
                console.error('AWAS V2: Keep-alive ping error —', err.message);
            }
        }, 14 * 60 * 1000);
    }
});

module.exports = app;
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Resend } = require('resend');
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── HELPER: Generate temporary password ─────────────────────────────────────
function generateTempPassword() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ─── HELPER: Generate invoice number ─────────────────────────────────────────
async function generateInvoiceNumber() {
    const year = new Date().getFullYear();
    const count = await prisma.invoice.count();
    return `AWAS-INV-${year}-${String(count + 1).padStart(4, '0')}`;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        const [
            totalInsurers,
            activeInsurers,
            totalDrivers,
            activeDrivers,
            newDriversToday,
            newDriversMonth,
            totalWrits,
            newWritsToday,
            newWritsMonth,
            totalInvoices,
            unpaidInvoices
        ] = await Promise.all([
            prisma.insurer.count(),
            prisma.insurer.count({ where: { status: 'ACTIVE' } }),
            prisma.driver.count(),
            prisma.driver.count({ where: { status: 'ACTIVE' } }),
            prisma.driver.count({ where: { createdAt: { gte: today } } }),
            prisma.driver.count({ where: { createdAt: { gte: thisMonth } } }),
            prisma.accidentLog.count(),
            prisma.accidentLog.count({ where: { createdAt: { gte: today } } }),
            prisma.accidentLog.count({ where: { createdAt: { gte: thisMonth } } }),
            prisma.invoice.count(),
            prisma.invoice.count({ where: { isPaid: false } })
        ]);

        return res.status(200).json({
            insurers: { total: totalInsurers, active: activeInsurers },
            drivers: { total: totalDrivers, active: activeDrivers, newToday: newDriversToday, newMonth: newDriversMonth },
            writs: { total: totalWrits, newToday: newWritsToday, newMonth: newWritsMonth },
            invoices: { total: totalInvoices, unpaid: unpaidInvoices }
        });

    } catch (error) {
        console.error('AWAS V2 Admin Dashboard Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── CREATE INSURER ───────────────────────────────────────────────────────────
exports.createInsurer = async (req, res) => {
    try {
        const { name, code, email, contactPerson, phone, revenueShare, awasShare, policyFee } = req.body;

        if (!name || !code || !email || !contactPerson || !phone) {
            return res.status(400).json({ error: 'Semua medan wajib diperlukan.' });
        }

        const existing = await prisma.insurer.findFirst({
            where: { OR: [{ email: email.toLowerCase() }, { code: code.toUpperCase() }] }
        });
        if (existing) {
            return res.status(409).json({ error: 'Emel atau kod insurans sudah wujud.' });
        }

        const tempPassword = generateTempPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 12);

        const insurer = await prisma.insurer.create({
            data: {
                name,
                code: code.toUpperCase(),
                email: email.toLowerCase(),
                contactPerson,
                phone,
                passwordHash,
                mustChangePassword: true,
                revenueShare: revenueShare || 50.00,
                awasShare: awasShare || 70.00,
                policyFee: policyFee || 120.00
            }
        });

        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: insurer.email,
                subject: '[AWAS] Selamat Datang ke Portal Insurans AWAS',
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                    <h2 style="color:#0f172a;">Selamat Datang, ${insurer.name}</h2>
                    <p>Akaun portal insurans AWAS anda telah berjaya dicipta.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Portal URL</td><td style="padding:8px;">${process.env.FE_URL}/insurer</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Emel</td><td style="padding:8px;">${insurer.email}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Kata Laluan Sementara</td><td style="padding:8px;font-weight:800;color:#dc2626;">${tempPassword}</td></tr>
                    </table>
                    <p style="color:#dc2626;font-weight:700;">Sila tukar kata laluan anda selepas log masuk pertama.</p>
                    <div style="margin:24px 0;">
                        <a href="${process.env.FE_URL}/insurer" style="background:#0f1623;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Log Masuk Portal</a>
                    </div>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V2: Insurer welcome email fault:', emailErr);
        }

        console.log(`AWAS V2: Insurer ${insurer.name} created. Temp password: ${tempPassword}`);

        return res.status(201).json({
            message: `Insurans ${insurer.name} berjaya dicipta. Emel selamat datang telah dihantar.`,
            insurerId: insurer.id,
            code: insurer.code
        });

    } catch (error) {
        console.error('AWAS V2 Create Insurer Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET ALL INSURERS ─────────────────────────────────────────────────────────
exports.getInsurers = async (req, res) => {
    try {
        const insurers = await prisma.insurer.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, name: true, code: true, email: true,
                contactPerson: true, phone: true, status: true,
                revenueShare: true, awasShare: true, policyFee: true,
                createdAt: true,
                _count: { select: { drivers: true, invoices: true } }
            }
        });
        return res.status(200).json({ count: insurers.length, insurers });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── SUSPEND / ACTIVATE INSURER ───────────────────────────────────────────────
exports.toggleInsurerStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const insurer = await prisma.insurer.findUnique({ where: { id: parseInt(id) } });
        if (!insurer) return res.status(404).json({ error: 'Insurans tidak dijumpai.' });

        const newStatus = insurer.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
        await prisma.insurer.update({ where: { id: parseInt(id) }, data: { status: newStatus } });

        return res.status(200).json({ message: `${insurer.name} status dikemas kini kepada ${newStatus}.` });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── CSV UPLOAD — BULK CREATE DRIVERS ────────────────────────────────────────
// Insurer uploads actual .csv file daily
// CSV columns: vehiclePlate, vehicleMakeModel, vehicleType, mykadLastFour,
//              phone, email, policyNumber, policyExpiry
exports.uploadCsv = async (req, res) => {
    try {
        const { insurerId } = req.body;

        if (!insurerId) {
            return res.status(400).json({ error: 'insurerId diperlukan.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Fail CSV diperlukan.' });
        }

        const insurer = await prisma.insurer.findUnique({ where: { id: parseInt(insurerId) } });
        if (!insurer) return res.status(404).json({ error: 'Insurans tidak dijumpai.' });

        // Parse CSV from buffer
        const csvContent = req.file.buffer.toString('utf8');
        const lines = csvContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        if (lines.length < 2) {
            return res.status(400).json({ error: 'CSV kosong atau tiada data.' });
        }

        // First line = headers
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, ''));

        // Validate required headers
        const required = ['vehicleplate', 'email', 'policynumber', 'policyexpiry'];
        const missingHeaders = required.filter(r => !headers.includes(r));
        if (missingHeaders.length > 0) {
            return res.status(400).json({ error: `Header CSV tidak lengkap. Missing: ${missingHeaders.join(', ')}` });
        }

        // Parse data rows
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim());
            const row = {};
            headers.forEach((h, idx) => {
                row[h] = values[idx] || '';
            });
            rows.push(row);
        }

        let successRows = 0;
        let failedRows = 0;
        const errors = [];

        for (const row of rows) {
            try {
                const plate = (row['vehicleplate'] || '').toUpperCase().replace(/\s+/g, '');
                const policyNumber = (row['policynumber'] || '').toUpperCase().replace(/\s+/g, '');
                const email = (row['email'] || '').toLowerCase().trim();
                const policyExpiry = row['policyexpiry'];

                if (!plate || !email || !policyNumber || !policyExpiry) {
                    failedRows++;
                    errors.push(`Row ${successRows + failedRows} skipped — missing required fields: ${plate || 'no plate'}`);
                    continue;
                }

                // Check existing — update if exists
                const existing = await prisma.driver.findFirst({
                    where: { OR: [{ vehiclePlate: plate }, { policyNumber }] }
                });

                if (existing) {
                    await prisma.driver.update({
                        where: { vehiclePlate: plate },
                        data: {
                            policyExpiry: new Date(policyExpiry),
                            policyNumber,
                            status: 'ACTIVE'
                        }
                    });
                    successRows++;
                    continue;
                }

                // Create new driver
                const tempPassword = generateTempPassword();
                const passwordHash = await bcrypt.hash(tempPassword, 12);

                await prisma.driver.create({
                    data: {
                        insurerId: parseInt(insurerId),
                        vehiclePlate: plate,
                        vehicleMakeModel: row['vehiclemakemodel'] || 'Unknown',
                        vehicleType: row['vehicletype'] || 'CAR',
                        mykadLastFour: row['mykadlastfour'] || '0000',
                        phone: row['phone'] || '',
                        email,
                        passwordHash,
                        mustChangePassword: true,
                        policyNumber,
                        policyExpiry: new Date(policyExpiry),
                        status: 'ACTIVE'
                    }
                });

                // Send welcome email
                try {
                    await resend.emails.send({
                        from: 'AWAS <hello@awas.asia>',
                        to: email,
                        subject: '[AWAS] Akaun AWAS Anda Telah Diaktifkan',
                        html: `
                            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                            <h2 style="color:#0f172a;">Selamat Datang ke AWAS</h2>
                            <p>Akaun AWAS anda telah diaktifkan melalui polisi insurans <strong>${insurer.name}</strong>.</p>
                            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                                <tr><td style="padding:8px;font-weight:700;color:#475569;">URL</td><td style="padding:8px;">${process.env.FE_URL}</td></tr>
                                <tr><td style="padding:8px;font-weight:700;color:#475569;">Nombor Plat (Username)</td><td style="padding:8px;font-weight:800;">${plate}</td></tr>
                                <tr><td style="padding:8px;font-weight:700;color:#475569;">Kata Laluan Sementara</td><td style="padding:8px;font-weight:800;color:#dc2626;">${tempPassword}</td></tr>
                            </table>
                            <p style="color:#dc2626;font-weight:700;">Sila tukar kata laluan anda selepas log masuk pertama.</p>
                            <div style="margin:24px 0;">
                                <a href="${process.env.FE_URL}" style="background:#16a34a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Buka AWAS</a>
                            </div>
                            <p style="font-size:0.75rem;color:#94a3b8;">Polisi: ${policyNumber} | Tamat: ${new Date(policyExpiry).toLocaleDateString('ms-MY')}</p>
                            </div>
                        `
                    });
                } catch (emailErr) {
                    console.error(`AWAS V2: Welcome email fault for ${plate}:`, emailErr);
                }

                successRows++;

            } catch (rowErr) {
                failedRows++;
                errors.push(`Row error: ${rowErr.message}`);
            }
        }

        // Log CSV upload
        await prisma.csvUpload.create({
            data: {
                insurerId: parseInt(insurerId),
                fileName: req.file.originalname || 'upload.csv',
                totalRows: rows.length,
                successRows,
                failedRows
            }
        });

        console.log(`AWAS V2: CSV upload for insurer ${insurerId} — ${successRows} success, ${failedRows} failed`);

        return res.status(200).json({
            message: `CSV diproses. ${successRows} berjaya, ${failedRows} gagal.`,
            successRows,
            failedRows,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('AWAS V2 CSV Upload Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET ALL DRIVERS ──────────────────────────────────────────────────────────
exports.getDrivers = async (req, res) => {
    try {
        const { insurerId } = req.query;
        const where = insurerId ? { insurerId: parseInt(insurerId) } : {};

        const drivers = await prisma.driver.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, vehiclePlate: true, vehicleMakeModel: true,
                vehicleType: true, phone: true, email: true,
                policyNumber: true, policyExpiry: true, status: true,
                createdAt: true,
                insurer: { select: { name: true, code: true } },
                _count: { select: { accidentLogs: true } }
            }
        });

        return res.status(200).json({ count: drivers.length, drivers });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET ALL WRITS ────────────────────────────────────────────────────────────
exports.getWrits = async (req, res) => {
    try {
        const writs = await prisma.accidentLog.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, writNumber: true, vehiclePlate: true,
                writStatus: true, logHash: true, videoHash: true,
                latitude: true, longitude: true,
                roadCondition: true, weatherCondition: true, injuryStatus: true,
                createdAt: true,
                driver: { select: { insurer: { select: { name: true, code: true } } } }
            }
        });
        return res.status(200).json({ count: writs.length, writs });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GENERATE INVOICE ─────────────────────────────────────────────────────────
exports.generateInvoice = async (req, res) => {
    try {
        const { insurerId, periodStart, periodEnd } = req.body;

        if (!insurerId || !periodStart || !periodEnd) {
            return res.status(400).json({ error: 'insurerId, periodStart dan periodEnd diperlukan.' });
        }

        const insurer = await prisma.insurer.findUnique({
            where: { id: parseInt(insurerId) }
        });
        if (!insurer) return res.status(404).json({ error: 'Insurans tidak dijumpai.' });

        const totalPolicies = await prisma.driver.count({
            where: {
                insurerId: parseInt(insurerId),
                status: 'ACTIVE'
            }
        });

        const awasShare = parseFloat(insurer.awasShare);
        const totalAmount = awasShare * totalPolicies;
        const invoiceNumber = await generateInvoiceNumber();

        const invoice = await prisma.invoice.create({
            data: {
                invoiceNumber,
                insurerId: parseInt(insurerId),
                periodStart: new Date(periodStart),
                periodEnd: new Date(periodEnd),
                totalPolicies,
                awasShare,
                totalAmount
            }
        });

        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: insurer.email,
                subject: `[AWAS] Invois ${invoiceNumber}`,
                html: `
                    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
                    <h2 style="color:#0f172a;">Invois AWAS</h2>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Nombor Invois</td><td style="padding:8px;font-weight:800;">${invoiceNumber}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Syarikat</td><td style="padding:8px;">${insurer.name}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Tempoh</td><td style="padding:8px;">${new Date(periodStart).toLocaleDateString('ms-MY')} — ${new Date(periodEnd).toLocaleDateString('ms-MY')}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Jumlah Polisi Aktif</td><td style="padding:8px;">${totalPolicies}</td></tr>
                        <tr><td style="padding:8px;font-weight:700;color:#475569;">Kadar AWAS</td><td style="padding:8px;">RM${awasShare.toFixed(2)} / polisi</td></tr>
                        <tr style="background:#f0fdf4;"><td style="padding:12px;font-weight:800;font-size:1.1rem;">JUMLAH PERLU DIBAYAR</td><td style="padding:12px;font-weight:800;font-size:1.1rem;color:#16a34a;">RM${totalAmount.toFixed(2)}</td></tr>
                    </table>
                    <p>Sila buat pembayaran kepada:</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f8fafc;">
                        <tr><td style="padding:8px;font-weight:700;">Nama Syarikat</td><td style="padding:8px;">AWAS Premium Resources</td></tr>
                        <tr><td style="padding:8px;font-weight:700;">No. SSM</td><td style="padding:8px;">202603141446</td></tr>
                        <tr><td style="padding:8px;font-weight:700;">Emel</td><td style="padding:8px;">hello@awas.asia</td></tr>
                    </table>
                    <p style="font-size:0.8rem;color:#64748b;">Invois ini dijana secara automatik oleh sistem AWAS.</p>
                    </div>
                `
            });
        } catch (emailErr) {
            console.error('AWAS V2: Invoice email fault:', emailErr);
        }

        return res.status(201).json({
            message: `Invois ${invoiceNumber} berjaya dijana dan dihantar kepada ${insurer.email}.`,
            invoice: {
                invoiceNumber,
                totalPolicies,
                awasShare,
                totalAmount,
                periodStart,
                periodEnd
            }
        });

    } catch (error) {
        console.error('AWAS V2 Generate Invoice Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET ALL INVOICES ─────────────────────────────────────────────────────────
exports.getInvoices = async (req, res) => {
    try {
        const invoices = await prisma.invoice.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                insurer: { select: { name: true, code: true, email: true } }
            }
        });
        return res.status(200).json({ count: invoices.length, invoices });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── MARK INVOICE PAID ────────────────────────────────────────────────────────
exports.markInvoicePaid = async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await prisma.invoice.findUnique({ where: { id: parseInt(id) } });
        if (!invoice) return res.status(404).json({ error: 'Invois tidak dijumpai.' });
        if (invoice.isPaid) return res.status(409).json({ error: 'Invois sudah dibayar.' });

        await prisma.invoice.update({
            where: { id: parseInt(id) },
            data: { isPaid: true, paidAt: new Date() }
        });

        return res.status(200).json({ message: `Invois ${invoice.invoiceNumber} ditanda sebagai dibayar.` });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET CSV UPLOAD HISTORY ───────────────────────────────────────────────────
exports.getCsvUploads = async (req, res) => {
    try {
        const uploads = await prisma.csvUpload.findMany({
            orderBy: { uploadedAt: 'desc' },
            take: 50
        });
        return res.status(200).json({ count: uploads.length, uploads });
    } catch (error) {
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};
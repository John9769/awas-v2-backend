const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── GET MY PROFILE ───────────────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate },
            select: {
                id: true,
                vehiclePlate: true,
                vehicleMakeModel: true,
                vehicleType: true,
                phone: true,
                email: true,
                policyNumber: true,
                policyExpiry: true,
                status: true,
                createdAt: true,
                insurer: {
                    select: {
                        name: true,
                        code: true,
                        phone: true
                    }
                },
                _count: { select: { accidentLogs: true } }
            }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Akaun tidak dijumpai.' });
        }

        const isExpired = new Date() > new Date(driver.policyExpiry);
        const daysLeft = Math.ceil((new Date(driver.policyExpiry) - new Date()) / (1000 * 60 * 60 * 24));

        return res.status(200).json({
            ...driver,
            policyExpired: isExpired,
            policyDaysLeft: isExpired ? 0 : daysLeft
        });

    } catch (error) {
        console.error('AWAS V2 getProfile Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};

// ─── GET MY WRIT HISTORY ──────────────────────────────────────────────────────
exports.getMyHistory = async (req, res) => {
    try {
        const { vehiclePlate } = req.driver;

        const writs = await prisma.accidentLog.findMany({
            where: { vehiclePlate },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                writNumber: true,
                logHash: true,
                videoHash: true,
                imageHashes: true,
                audioHash: true,
                latitude: true,
                longitude: true,
                roadCondition: true,
                weatherCondition: true,
                injuryStatus: true,
                incidentDescription: true,
                claimType: true,
                otherVehiclePlate: true,
                otherVehicleMakeModel: true,
                writStage: true,
                submittedAt: true,
                videoSealedAt: true,
                createdAt: true
            }
        });

        return res.status(200).json({ count: writs.length, writs });

    } catch (error) {
        console.error('AWAS V2 getMyHistory Fault:', error);
        return res.status(500).json({ error: 'Ralat pelayan.' });
    }
};
const multer = require('multer');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedVideo = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];
    const allowedImage = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    const allowedAudio = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav'];
    const allowedCsv = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];

    if ([...allowedVideo, ...allowedImage, ...allowedAudio, ...allowedCsv].includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Jenis fail tidak dibenarkan.'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 100 * 1024 * 1024,
        files: 9
    }
});

// Single video upload
exports.uploadVideo = upload.single('video');

// Video + images + audio + other party images
exports.uploadEvidence = upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'images', maxCount: 5 },
    { name: 'audio', maxCount: 1 },
    { name: 'otherImages', maxCount: 2 }
]);

// CSV upload
exports.uploadCsv = upload.single('csv');

// V3: Police report upload (single image/PDF)
exports.uploadPoliceReport = upload.fields([
    { name: 'policeReport', maxCount: 1 }
]);

// V3: Settlement docs upload
// IC + driving licence + VOC + discharge voucher
exports.uploadSettlementDocs = upload.fields([
    { name: 'ic', maxCount: 1 },
    { name: 'licence', maxCount: 1 },
    { name: 'voc', maxCount: 1 },
    { name: 'dischargeVoucher', maxCount: 1 }
]);
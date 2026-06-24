const multer = require('multer');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedVideo = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];
    const allowedImage = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    const allowedCsv = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];

    if ([...allowedVideo, ...allowedImage, ...allowedCsv].includes(file.mimetype)) {
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
        files: 5
    }
});

// Single video upload
exports.uploadVideo = upload.single('video');

// Video + multiple images
exports.uploadEvidence = upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'images', maxCount: 4 }
]);

// CSV upload
exports.uploadCsv = upload.single('csv');
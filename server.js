const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// تنظیمات
const PORT = process.env.PORT || 3000;
const MAX_FILES = 20;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ایجاد پوشه آپلود
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// تنظیمات آپلود
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '_' + file.originalname;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE }
});

// راه‌اندازی دیتابیس SQLite
const db = new Database('database.db');

// ساخت جداول
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fullName TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        createdAt INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS presence (
        userId INTEGER PRIMARY KEY,
        socketId TEXT,
        online INTEGER DEFAULT 0,
        fullName TEXT,
        cameraOn INTEGER DEFAULT 0,
        audioOn INTEGER DEFAULT 0,
        lastSeen INTEGER,
        FOREIGN KEY (userId) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        originalName TEXT NOT NULL,
        size INTEGER,
        uploadedBy INTEGER,
        uploaderName TEXT,
        uploadedAt INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (uploadedBy) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS private_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromUserId INTEGER,
        toUserId INTEGER,
        status TEXT DEFAULT 'pending',
        createdAt INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (fromUserId) REFERENCES users(id),
        FOREIGN KEY (toUserId) REFERENCES users(id)
    );
`);

// Prepared Statements
const stmtRegister = db.prepare('INSERT INTO users (fullName, email, password) VALUES (?, ?, ?)');
const stmtLogin = db.prepare('SELECT * FROM users WHERE email = ? AND password = ?');
const stmtGetUser = db.prepare('SELECT id, fullName, email FROM users WHERE id = ?');
const stmtSetPresence = db.prepare(`
    INSERT OR REPLACE INTO presence (userId, socketId, online, fullName, cameraOn, audioOn, lastSeen) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetOnlineUsers = db.prepare('SELECT * FROM presence WHERE online = 1');
const stmtSetOffline = db.prepare('UPDATE presence SET online = 0, lastSeen = ? WHERE socketId = ?');

// ذخیره اطلاعات سوکت‌ها
const connectedUsers = new Map();

// API: ثبت نام
app.post('/api/register', (req, res) => {
    try {
        const { fullName, email, password } = req.body;
        const result = stmtRegister.run(fullName, email, password);
        res.json({ success: true, userId: result.lastInsertRowid });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// API: ورود
app.post('/api/login', (req, res) => {
    try {
        const { email, password } = req.body;
        const user = stmtLogin.get(email, password);
        if (user) {
            res.json({ 
                success: true, 
                user: { id: user.id, fullName: user.fullName, email: user.email }
            });
        } else {
            res.status(401).json({ success: false, error: 'ایمیل یا رمز عبور اشتباه است' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: لیست کاربران آنلاین
app.get('/api/online-users', (req, res) => {
    try {
        const users = stmtGetOnlineUsers.all();
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: آپلود فایل
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        const { userId, userName } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ success: false, error: 'فایلی انتخاب نشده' });
        }

        // ذخیره در دیتابیس
        const stmt = db.prepare('INSERT INTO files (filename, originalName, size, uploadedBy, uploaderName) VALUES (?, ?, ?, ?, ?)');
        stmt.run(file.filename, file.originalname, file.size, userId, userName);

        // حذف فایل‌های قدیمی (بیش از 20)
        const allFiles = db.prepare('SELECT * FROM files ORDER BY uploadedAt DESC').all();
        if (allFiles.length > MAX_FILES) {
            const oldFiles = allFiles.slice(MAX_FILES);
            oldFiles.forEach(oldFile => {
                // حذف از دیتابیس
                db.prepare('DELETE FROM files WHERE id = ?').run(oldFile.id);
                // حذف فایل فیزیکی
                const filePath = path.join(__dirname, 'uploads', oldFile.filename);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            });
        }

        // ارسال لیست جدید به همه
        const files = db.prepare('SELECT * FROM files ORDER BY uploadedAt DESC LIMIT ?').all(MAX_FILES);
        io.emit('files-updated', files);

        res.json({ success: true, file: file.filename });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: لیست فایل‌ها
app.get('/api/files', (req, res) => {
    try {
        const files = db.prepare('SELECT * FROM files ORDER BY uploadedAt DESC LIMIT ?').all(MAX_FILES);
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// WebSocket: اتصال
io.on('connection', (socket) => {
    console.log('کاربر جدید متصل شد:', socket.id);

    // ثبت کاربر
    socket.on('user-connected', (userData) => {
        connectedUsers.set(socket.id, userData);
        
        stmtSetPresence.run(
            userData.userId,
            socket.id,
            1,
            userData.fullName,
            0,
            0,
            Date.now()
        );

        // اطلاع به همه
        const onlineUsers = stmtGetOnlineUsers.all();
        io.emit('users-updated', onlineUsers);
        
        // پخش صدای ورود به همه
        socket.broadcast.emit('user-joined', { fullName: userData.fullName });
    });

    // تغییر وضعیت دوربین/صدا
    socket.on('media-state-changed', (data) => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            db.prepare('UPDATE presence SET cameraOn = ?, audioOn = ? WHERE socketId = ?')
              .run(data.cameraOn ? 1 : 0, data.audioOn ? 1 : 0, socket.id);
            
            const onlineUsers = stmtGetOnlineUsers.all();
            io.emit('users-updated', onlineUsers);
        }
    });

    // درخواست ارتباط خصوصی
    socket.on('private-call-request', (data) => {
        const targetUser = Array.from(connectedUsers.entries())
            .find(([sid, user]) => user.userId === data.toUserId);
        
        if (targetUser) {
            io.to(targetUser[0]).emit('incoming-private-call', {
                fromUserId: data.fromUserId,
                fromName: data.fromName
            });
        }
    });

    // قبول/رد تماس خصوصی
    socket.on('private-call-response', (data) => {
        const targetUser = Array.from(connectedUsers.entries())
            .find(([sid, user]) => user.userId === data.toUserId);
        
        if (targetUser) {
            io.to(targetUser[0]).emit('private-call-accepted', data);
        }
    });

    // WebRTC Signaling
    socket.on('offer', (data) => {
        const targetUser = Array.from(connectedUsers.entries())
            .find(([sid, user]) => user.userId === data.toUserId);
        
        if (targetUser) {
            io.to(targetUser[0]).emit('offer', {
                offer: data.offer,
                fromUserId: connectedUsers.get(socket.id).userId
            });
        }
    });

    socket.on('answer', (data) => {
        const targetUser = Array.from(connectedUsers.entries())
            .find(([sid, user]) => user.userId === data.toUserId);
        
        if (targetUser) {
            io.to(targetUser[0]).emit('answer', {
                answer: data.answer,
                fromUserId: connectedUsers.get(socket.id).userId
            });
        }
    });

    socket.on('ice-candidate', (data) => {
        const targetUser = Array.from(connectedUsers.entries())
            .find(([sid, user]) => user.userId === data.toUserId);
        
        if (targetUser) {
            io.to(targetUser[0]).emit('ice-candidate', {
                candidate: data.candidate,
                fromUserId: connectedUsers.get(socket.id).userId
            });
        }
    });

    // قطع اتصال
    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            stmtSetOffline.run(Date.now(), socket.id);
            connectedUsers.delete(socket.id);
            
            const onlineUsers = stmtGetOnlineUsers.all();
            io.emit('users-updated', onlineUsers);
            
            console.log('کاربر قطع شد:', user.fullName);
        }
    });
});

// صفحه اصلی
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// شروع سرور
server.listen(PORT, () => {
    console.log(`✅ سرور در حال اجرا: http://localhost:${PORT}`);
    console.log(`📱 از موبایل: http://[IP-COMPUTER]:${PORT}`);
});

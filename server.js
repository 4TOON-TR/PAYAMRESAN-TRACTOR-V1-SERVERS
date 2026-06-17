const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');

const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 10 * 1024 * 1024 // 10MB برای عکس‌ها
});

// ============================================================
//  متغیرهای سراسری
// ============================================================

const onlineUsers = {}; // socketId -> { username, color, groupId }
const userSockets = {}; // username -> socketId

// ============================================================
//  APIهای REST (برای کارهای مدیریتی)
// ============================================================

// دریافت لیست کاربران
app.get('/api/users', async (req, res) => {
    try {
        const users = await db.getAllUsers();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// دریافت لیست گروه‌ها
app.get('/api/groups', async (req, res) => {
    try {
        const groups = await db.getGroups();
        res.json(groups);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ساخت گروه جدید (فقط ادمین)
app.post('/api/groups', async (req, res) => {
    const { name, description, adminUsername } = req.body;
    try {
        const user = await db.getUserByUsername(adminUsername);
        if (!user || !user.is_admin) {
            return res.status(403).json({ error: 'فقط ادمین می‌تواند گروه بسازد' });
        }
        const groupId = await db.addGroup(name, description, adminUsername);
        res.json({ success: true, groupId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// حذف گروه (فقط ادمین)
app.delete('/api/groups/:groupId', async (req, res) => {
    const { groupId } = req.params;
    const { adminUsername } = req.body;
    try {
        const user = await db.getUserByUsername(adminUsername);
        if (!user || !user.is_admin) {
            return res.status(403).json({ error: 'فقط ادمین می‌تواند گروه را حذف کند' });
        }
        const result = await db.deleteGroup(groupId);
        if (result > 0) {
            // به همه کاربران اطلاع بده
            io.emit('group deleted', { groupId });
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'گروه پیدا نشد' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// بن کردن کاربر (فقط ادمین)
app.post('/api/ban/:username', async (req, res) => {
    const { username } = req.params;
    const { adminUsername } = req.body;
    try {
        const admin = await db.getUserByUsername(adminUsername);
        if (!admin || !admin.is_admin) {
            return res.status(403).json({ error: 'فقط ادمین می‌تواند بن کند' });
        }
        const user = await db.getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'کاربر پیدا نشد' });
        }
        await db.banUser(user.id, adminUsername);
        // اخراج کاربر از سیستم
        if (userSockets[username]) {
            const socketId = userSockets[username];
            io.to(socketId).emit('banned', { message: 'شما توسط ادمین بن شدید!' });
            io.sockets.sockets.get(socketId)?.disconnect();
        }
        io.emit('system message', `🔨 ${username} توسط ادمین بن شد`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// آنبان کردن کاربر (فقط ادمین)
app.post('/api/unban/:username', async (req, res) => {
    const { username } = req.params;
    const { adminUsername } = req.body;
    try {
        const admin = await db.getUserByUsername(adminUsername);
        if (!admin || !admin.is_admin) {
            return res.status(403).json({ error: 'فقط ادمین می‌تواند آنبان کند' });
        }
        const user = await db.getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'کاربر پیدا نشد' });
        }
        await db.unbanUser(user.id);
        io.emit('system message', `✅ ${username} آنبان شد`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  Socket.IO - مدیریت اتصالات
// ============================================================

io.on('connection', async (socket) => {
    console.log('🔗 کاربر جدید متصل شد:', socket.id);

    let currentUser = null;
    let currentGroupId = null;

    // ============================================================
    //  ۱. ثبت‌نام و ورود
    // ============================================================

    socket.on('register', async (data) => {
        const { username, password, color } = data;

        try {
            // بررسی اینکه کاربر قبلاً ثبت‌نام نکرده باشد
            const existingUser = await db.getUserByUsername(username);
            if (existingUser) {
                socket.emit('register error', { message: 'این نام کاربری قبلاً ثبت‌نام شده است!' });
                return;
            }

            // هش کردن رمز عبور
            const hashedPassword = await bcrypt.hash(password, 10);

            // ذخیره در دیتابیس
            await db.createUser(username, hashedPassword, color);

            socket.emit('register success', { message: 'ثبت‌نام با موفقیت انجام شد!' });
        } catch (err) {
            socket.emit('register error', { message: 'خطا در ثبت‌نام: ' + err.message });
        }
    });

    socket.on('login', async (data) => {
        const { username, password } = data;

        try {
            // بررسی بن بودن کاربر
            const isBanned = await db.isUserBanned(username);
            if (isBanned) {
                socket.emit('login error', { message: '❌ شما توسط ادمین بن شده‌اید!' });
                return;
            }

            // پیدا کردن کاربر
            const user = await db.getUserByUsername(username);
            if (!user) {
                socket.emit('login error', { message: '❌ نام کاربری یا رمز عبور اشتباه است!' });
                return;
            }

            // بررسی رمز عبور
            const isPasswordValid = await bcrypt.compare(password, user.password_hash);
            if (!isPasswordValid) {
                socket.emit('login error', { message: '❌ نام کاربری یا رمز عبور اشتباه است!' });
                return;
            }

            // ذخیره اطلاعات کاربر
            currentUser = {
                id: user.id,
                username: user.username,
                color: user.color,
                isAdmin: user.is_admin === 1
            };

            onlineUsers[socket.id] = {
                username: user.username,
                color: user.color,
                groupId: null
            };
            userSockets[user.username] = socket.id;

            // ارسال تایید ورود
            socket.emit('login success', {
                user: currentUser,
                isAdmin: currentUser.isAdmin
            });

            // دریافت لیست گروه‌ها و ارسال به کاربر
            const groups = await db.getGroups();
            socket.emit('groups list', groups);

            // اضافه کردن کاربر به گروه‌های پیش‌فرض
            for (const group of groups) {
                await db.addUserToGroup(user.id, group.id);
            }

            // ارسال پیام خوش‌آمدگویی سیستم
            socket.emit('system message', `🌟 به چت‌روم ۴TOON خوش آمدی، ${user.username}!`);

            // ارسال لیست کاربران آنلاین به همه
            io.emit('user list', Object.values(onlineUsers).map(u => u.username));

            console.log(`✅ ${user.username} وارد شد`);
        } catch (err) {
            socket.emit('login error', { message: 'خطا در ورود: ' + err.message });
        }
    });

    // ============================================================
    //  ۲. ورود به گروه
    // ============================================================

    socket.on('join group', async (data) => {
        const { groupId, username } = data;

        try {
            const user = await db.getUserByUsername(username);
            if (!user) return;

            // بررسی اینکه کاربر بن نشده باشد
            if (user.is_banned === 1) {
                socket.emit('system message', '❌ شما بن هستید و نمی‌توانید چت کنید!');
                return;
            }

            // اضافه کردن کاربر به گروه
            await db.addUserToGroup(user.id, groupId);

            currentGroupId = groupId;
            if (onlineUsers[socket.id]) {
                onlineUsers[socket.id].groupId = groupId;
            }

            // دریافت تاریخچه گروه
            const messages = await db.getMessages(groupId);
            socket.emit('group history', messages);

            // دریافت لیست اعضای گروه
            const members = await db.getGroupMembers(groupId);
            socket.emit('group members', members);

            // اطلاع به دیگران
            socket.to(`group_${groupId}`).emit('system message', `👋 ${username} وارد گروه شد`);

            // پیوستن به اتاق گروه
            socket.join(`group_${groupId}`);

            // به‌روزرسانی لیست آنلاین‌ها
            io.emit('user list', Object.values(onlineUsers).map(u => u.username));

            console.log(`📌 ${username} وارد گروه ${groupId} شد`);
        } catch (err) {
            socket.emit('system message', '❌ خطا در ورود به گروه: ' + err.message);
        }
    });

    // ============================================================
    //  ۳. ارسال پیام
    // ============================================================

    socket.on('chat message', async (data) => {
        const { username, text, groupId, image } = data;

        try {
            // بررسی بن بودن کاربر
            const isBanned = await db.isUserBanned(username);
            if (isBanned) {
                socket.emit('system message', '❌ شما بن هستید و نمی‌توانید پیام بفرستید!');
                return;
            }

            const user = await db.getUserByUsername(username);
            if (!user) return;

            // ذخیره پیام در دیتابیس
            const messageId = await db.saveMessage(groupId, user.id, username, text, image || null);

            // دریافت پیام ذخیره شده با زمان
            const savedMsg = {
                id: messageId,
                username: username,
                text: text,
                image: image || null,
                timestamp: new Date().toLocaleTimeString('fa-IR'),
                is_edited: 0,
                is_deleted: 0
            };

            // ارسال پیام به همه کاربران گروه (به جز خودش)
            socket.to(`group_${groupId}`).emit('chat message', savedMsg);

            // ارسال پیام به خودش (برای نمایش با زمان درست)
            socket.emit('chat message confirm', savedMsg);

            console.log(`💬 ${username}: ${text?.substring(0, 30)}...`);
        } catch (err) {
            socket.emit('system message', '❌ خطا در ارسال پیام: ' + err.message);
        }
    });

    // ============================================================
    //  ۴. پیام خصوصی
    // ============================================================

    socket.on('private message', async (data) => {
        const { username, targetUsername, text, image } = data;

        try {
            const user = await db.getUserByUsername(username);
            if (!user) return;

            // ذخیره پیام خصوصی
            await db.savePrivateMessage(user.id, username, text, targetUsername, image || null);

            // ارسال به گیرنده اگر آنلاین باشد
            if (userSockets[targetUsername]) {
                const targetSocketId = userSockets[targetUsername];
                io.to(targetSocketId).emit('private message', {
                    from: username,
                    text: text,
                    image: image || null,
                    timestamp: new Date().toLocaleTimeString('fa-IR')
                });
            }

            // تایید به فرستنده
            socket.emit('private message confirm', {
                to: targetUsername,
                text: text,
                image: image || null,
                timestamp: new Date().toLocaleTimeString('fa-IR')
            });

            console.log(`🔒 ${username} -> ${targetUsername}: ${text?.substring(0, 20)}...`);
        } catch (err) {
            socket.emit('system message', '❌ خطا در ارسال پیام خصوصی: ' + err.message);
        }
    });

    // ============================================================
    //  ۵. ویرایش پیام
    // ============================================================

    socket.on('edit message', async (data) => {
        const { messageId, newText, username } = data;

        try {
            const result = await db.editMessage(messageId, newText);
            if (result > 0) {
                // اطلاع به همه کاربران گروه
                io.emit('message edited', {
                    messageId,
                    newText,
                    username,
                    timestamp: new Date().toLocaleTimeString('fa-IR')
                });
            }
        } catch (err) {
            socket.emit('system message', '❌ خطا در ویرایش پیام: ' + err.message);
        }
    });

    // ============================================================
    //  ۶. حذف پیام
    // ============================================================

    socket.on('delete message', async (data) => {
        const { messageId, username } = data;

        try {
            const result = await db.deleteMessage(messageId);
            if (result > 0) {
                io.emit('message deleted', { messageId, username });
            }
        } catch (err) {
            socket.emit('system message', '❌ خطا در حذف پیام: ' + err.message);
        }
    });

    // ============================================================
    //  ۷. تایپینگ
    // ============================================================

    socket.on('typing', (data) => {
        const { username, groupId, isTyping } = data;
        if (isTyping) {
            socket.to(`group_${groupId}`).emit('typing', { username });
        } else {
            socket.to(`group_${groupId}`).emit('typing stop', { username });
        }
    });

    // ============================================================
    //  ۸. پاک کردن تمام پیام‌های گروه (فقط ادمین)
    // ============================================================

    socket.on('clear group history', async (data) => {
        const { groupId, adminUsername } = data;

        try {
            const admin = await db.getUserByUsername(adminUsername);
            if (!admin || !admin.is_admin) {
                socket.emit('system message', '❌ فقط ادمین می‌تواند تاریخچه را پاک کند!');
                return;
            }

            await db.deleteAllMessages(groupId);
            io.to(`group_${groupId}`).emit('system message', '🧹 تاریخچه گروه توسط ادمین پاک شد!');
        } catch (err) {
            socket.emit('system message', '❌ خطا در پاک کردن تاریخچه: ' + err.message);
        }
    });

    // ============================================================
    //  ۹. خروج کاربر
    // ============================================================

    socket.on('disconnect', () => {
        const user = onlineUsers[socket.id];
        if (user) {
            console.log(`❌ ${user.username} از چت خارج شد`);

            // اطلاع به دیگران
            if (user.groupId) {
                socket.to(`group_${user.groupId}`).emit('system message', `👋 ${user.username} از چت خارج شد`);
            }

            // حذف از لیست آنلاین‌ها
            delete onlineUsers[socket.id];
            delete userSockets[user.username];

            // به‌روزرسانی لیست آنلاین‌ها
            io.emit('user list', Object.values(onlineUsers).map(u => u.username));
        }
    });

    socket.on('user left', (data) => {
        const { username } = data;
        if (userSockets[username]) {
            const socketId = userSockets[username];
            const user = onlineUsers[socketId];
            if (user) {
                if (user.groupId) {
                    socket.to(`group_${user.groupId}`).emit('system message', `👋 ${username} از چت خارج شد`);
                }
                delete onlineUsers[socketId];
                delete userSockets[username];
                io.emit('user list', Object.values(onlineUsers).map(u => u.username));
            }
        }
    });
});

// ============================================================
//  راه‌اندازی سرور
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 سرور ۴TOON روی پورت ${PORT} روشن شد!`);
    console.log(`📊 دیتابیس: chat.db`);
});
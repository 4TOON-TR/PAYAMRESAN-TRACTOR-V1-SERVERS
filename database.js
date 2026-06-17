const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

// اتصال به دیتابیس (فایل chat.db در همان پوشه)
const db = new sqlite3.Database(path.join(__dirname, 'chat.db'));

// ============================================================
//  ایجاد جداول (اگر وجود نداشته باشند)
// ============================================================

db.serialize(() => {
    // جدول کاربران
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            color TEXT,
            is_admin INTEGER DEFAULT 0,
            is_banned INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // جدول گروه‌ها
    db.run(`
        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            created_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // جدول عضویت کاربران در گروه‌ها
    db.run(`
        CREATE TABLE IF NOT EXISTS group_members (
            user_id INTEGER,
            group_id INTEGER,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, group_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (group_id) REFERENCES groups(id)
        )
    `);

    // جدول پیام‌ها
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER,
            sender_id INTEGER,
            sender_name TEXT,
            text TEXT,
            image TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_edited INTEGER DEFAULT 0,
            is_deleted INTEGER DEFAULT 0,
            is_private INTEGER DEFAULT 0,
            private_for TEXT,
            FOREIGN KEY (group_id) REFERENCES groups(id),
            FOREIGN KEY (sender_id) REFERENCES users(id)
        )
    `);

    // جدول کاربران بن شده
    db.run(`
        CREATE TABLE IF NOT EXISTS banned_users (
            user_id INTEGER,
            banned_by TEXT,
            reason TEXT,
            banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // ============================================================
    //  اضافه کردن گروه‌های پیش‌فرض
    // ============================================================
    const defaultGroups = [
        { name: '💬 عمومی', description: 'گروه اصلی چت' },
        { name: '🎮 بازی', description: 'دنیای بازی‌ها' },
        { name: '🎬 فیلم', description: 'سینما و سریال' },
        { name: '✨ متفرقه', description: 'هر چیزی می‌خوای بگو' },
    ];

    defaultGroups.forEach(g => {
        db.run(
            `INSERT OR IGNORE INTO groups (name, description) VALUES (?, ?)`,
            [g.name, g.description]
        );
    });

    // ============================================================
    //  اضافه کردن کاربر ادمین پیش‌فرض
    // ============================================================
    const adminUsername = 'admin';
    const adminPassword = 'admin123';
    const hashedPassword = bcrypt.hashSync(adminPassword, 10);

    db.run(
        `INSERT OR IGNORE INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)`,
        [adminUsername, hashedPassword, 1]
    );
});

// ============================================================
//  توابع کمکی برای دسترسی به دیتابیس
// ============================================================

function getUserByUsername(username) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM users WHERE username = ?`,
            [username],
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
}

function createUser(username, passwordHash, color) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO users (username, password_hash, color) VALUES (?, ?, ?)`,
            [username, passwordHash, color],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function getAllUsers() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT id, username, color, is_admin, is_banned FROM users WHERE is_banned = 0`,
            [],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function getGroups() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT id, name, description FROM groups`,
            [],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function getGroupById(groupId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM groups WHERE id = ?`,
            [groupId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row);
            }
        );
    });
}

function addGroup(name, description, createdBy) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO groups (name, description, created_by) VALUES (?, ?, ?)`,
            [name, description, createdBy],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function deleteGroup(groupId) {
    return new Promise((resolve, reject) => {
        db.run(
            `DELETE FROM groups WHERE id = ?`,
            [groupId],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

function getMessages(groupId, limit = 100) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM messages 
             WHERE group_id = ? AND is_deleted = 0 AND is_private = 0
             ORDER BY timestamp DESC LIMIT ?`,
            [groupId, limit],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reverse());
            }
        );
    });
}

function saveMessage(groupId, senderId, senderName, text, image = null) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO messages (group_id, sender_id, sender_name, text, image) 
             VALUES (?, ?, ?, ?, ?)`,
            [groupId, senderId, senderName, text, image],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function savePrivateMessage(senderId, senderName, text, privateFor, image = null) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO messages (sender_id, sender_name, text, image, is_private, private_for) 
             VALUES (?, ?, ?, ?, 1, ?)`,
            [senderId, senderName, text, image, privateFor],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function getPrivateMessages(senderId, targetUsername) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM messages 
             WHERE is_private = 1 
             AND (sender_name = ? OR private_for = ?)
             AND is_deleted = 0
             ORDER BY timestamp DESC LIMIT 100`,
            [targetUsername, targetUsername],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reverse());
            }
        );
    });
}

function editMessage(messageId, newText) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE messages SET text = ?, is_edited = 1 WHERE id = ?`,
            [newText, messageId],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

function deleteMessage(messageId) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE messages SET is_deleted = 1 WHERE id = ?`,
            [messageId],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

function addUserToGroup(userId, groupId) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT OR IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)`,
            [userId, groupId],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

function getGroupMembers(groupId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT u.id, u.username, u.color 
             FROM users u 
             JOIN group_members gm ON u.id = gm.user_id 
             WHERE gm.group_id = ?`,
            [groupId],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function banUser(userId, bannedBy) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE users SET is_banned = 1 WHERE id = ?`,
            [userId],
            function(err) {
                if (err) reject(err);
                else {
                    db.run(
                        `INSERT INTO banned_users (user_id, banned_by) VALUES (?, ?)`,
                        [userId, bannedBy],
                        (err2) => {
                            if (err2) reject(err2);
                            else resolve(this.changes);
                        }
                    );
                }
            }
        );
    });
}

function unbanUser(userId) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE users SET is_banned = 0 WHERE id = ?`,
            [userId],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

function isUserBanned(username) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT is_banned FROM users WHERE username = ?`,
            [username],
            (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.is_banned === 1 : false);
            }
        );
    });
}

function deleteAllMessages(groupId) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE messages SET is_deleted = 1 WHERE group_id = ?`,
            [groupId],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

module.exports = {
    db,
    getUserByUsername,
    createUser,
    getAllUsers,
    getGroups,
    getGroupById,
    addGroup,
    deleteGroup,
    getMessages,
    saveMessage,
    savePrivateMessage,
    getPrivateMessages,
    editMessage,
    deleteMessage,
    addUserToGroup,
    getGroupMembers,
    banUser,
    unbanUser,
    isUserBanned,
    deleteAllMessages
};
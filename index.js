const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { DatabaseSync } = require("node:sqlite");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new DatabaseSync(path.join(__dirname, "mayotte.db"));
const DB_FILE = path.join(__dirname, "users.json");

let users = fs.existsSync(DB_FILE)
    ? JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
    : [];

users.forEach(u => {
    if (!Array.isArray(u.friends)) u.friends = [];
    if (!Array.isArray(u.friendRequests)) u.friendRequests = [];
});

function saveUsers() {
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages(sender_id, receiver_id, id);
`);

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        maxAge: 24 * 60 * 60 * 1000
    }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10
});

function requireLogin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Connexion nécessaire." });
    }
    next();
}

function currentUser(req) {
    return users.find(u => u.id === req.session.userId);
}

function areFriends(a, b) {
    return a && b &&
        Array.isArray(a.friends) &&
        a.friends.includes(b.id) &&
        Array.isArray(b.friends) &&
        b.friends.includes(a.id);
}

function publicUser(u) {
    return {
        id: u.id,
        username: u.username,
        bio: u.bio || "",
        avatar: u.avatar || ""
    };
}

// INSCRIPTION
app.post("/api/register", authLimiter, async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
            return res.status(400).json({ error: "Pseudo invalide." });

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return res.status(400).json({ error: "E-mail invalide." });

        if (password.length < 10 || password.length > 128)
            return res.status(400).json({ error: "Mot de passe invalide." });

        if (users.some(u => u.username.toLowerCase() === username.toLowerCase()))
            return res.status(409).json({ error: "Pseudo déjà utilisé." });

        if (users.some(u => u.email === email))
            return res.status(409).json({ error: "E-mail déjà utilisé." });

        const user = {
            id: crypto.randomUUID(),
            username,
            email,
            password: await bcrypt.hash(password, 12),
            bio: "",
            avatar: "",
            friends: [],
            friendRequests: [],
            createdAt: new Date().toISOString()
        };

        users.push(user);
        saveUsers();

        req.session.regenerate(err => {
            if (err) return res.status(500).json({ error: "Erreur de session." });
            req.session.userId = user.id;
            req.session.save(() => res.status(201).json({
                username: user.username
            }));
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur d'inscription." });
    }
});

// CONNEXION
app.post("/api/login", authLimiter, async (req, res) => {
    try {
        const identifier = String(req.body.identifier || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        const user = users.find(u =>
            u.username.toLowerCase() === identifier ||
            (u.email && u.email.toLowerCase() === identifier)
        );

        if (!user || !(await bcrypt.compare(password, user.password)))
            return res.status(401).json({ error: "Identifiants incorrects." });

        req.session.regenerate(err => {
            if (err) return res.status(500).json({ error: "Erreur de session." });
            req.session.userId = user.id;
            req.session.save(() => res.json({ username: user.username }));
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur de connexion." });
    }
});

// MON PROFIL
app.get("/api/me", requireLogin, (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(404).json({ error: "Compte introuvable." });
    res.json({ ...publicUser(user), email: user.email });
});

// MODIFIER BIO
app.patch("/api/profile", requireLogin, (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(404).json({ error: "Compte introuvable." });

    user.bio = String(req.body.bio || "").trim().slice(0, 300);
    saveUsers();
    res.json({ message: "Profil actualisé." });
});

// RECHERCHE
app.get("/api/users", requireLogin, (req, res) => {
    const me = currentUser(req);
    const q = String(req.query.q || "").trim().toLowerCase();

    res.json(users
        .filter(u => u.id !== me.id)
        .filter(u => !q || u.username.toLowerCase().includes(q))
        .slice(0, 30)
        .map(u => ({
            ...publicUser(u),
            isFriend: me.friends.includes(u.id),
            requestSent: me.friendRequests.includes(u.id),
            requestReceived: u.friendRequests.includes(me.id)
        })));
});

// ENVOYER UNE DEMANDE
app.post("/api/friends/request/:id", requireLogin, (req, res) => {
    const me = currentUser(req);
    const target = users.find(u => u.id === req.params.id);

    if (!target || target.id === me.id)
        return res.status(404).json({ error: "Utilisateur introuvable." });

    if (me.friends.includes(target.id))
        return res.status(409).json({ error: "Déjà amis." });

    if (target.friendRequests.includes(me.id))
        return res.status(409).json({ error: "Demande déjà envoyée." });

    if (me.friendRequests.includes(target.id))
        return res.status(409).json({ error: "Cette personne vous a déjà invité." });

    if (!me.friendRequests.includes(target.id)) {
        me.friendRequests.push(target.id);
        saveUsers();
    }

    res.json({ message: "Demande envoyée !" });
});

// DEMANDES REÇUES
app.get("/api/friends/requests", requireLogin, (req, res) => {
    const me = currentUser(req);
    res.json(me.friendRequests
        .map(id => users.find(u => u.id === id))
        .filter(Boolean)
        .map(publicUser));
});

// ACCEPTER OU REFUSER
app.post("/api/friends/:id/:action", requireLogin, (req, res) => {
    const me = currentUser(req);
    const id = req.params.id;
    const action = req.params.action;

    if (!["accept", "reject"].includes(action))
        return res.status(400).json({ error: "Action invalide." });

    if (!me.friendRequests.includes(id))
        return res.status(404).json({ error: "Demande introuvable." });

    me.friendRequests = me.friendRequests.filter(x => x !== id);

    if (action === "accept") {
        const other = users.find(u => u.id === id);
        if (other) {
            if (!me.friends.includes(id)) me.friends.push(id);
            if (!other.friends.includes(me.id)) other.friends.push(me.id);
        }
    }

    saveUsers();
    res.json({ message: "Opération réussie." });
});

// LISTE DES AMIS
app.get("/api/friends", requireLogin, (req, res) => {
    const me = currentUser(req);
    res.json(me.friends
        .map(id => users.find(u => u.id === id))
        .filter(Boolean)
        .map(publicUser));
});

// LISTE DES CONVERSATIONS
app.get("/api/conversations", requireLogin, (req, res) => {
    const me = currentUser(req);

    const results = me.friends.map(id => {
        const friend = users.find(u => u.id === id);
        if (!friend) return null;

        const last = db.prepare(`
            SELECT * FROM messages
            WHERE (sender_id=? AND receiver_id=?)
               OR (sender_id=? AND receiver_id=?)
            ORDER BY id DESC LIMIT 1
        `).get(me.id, id, id, me.id);

        const unread = db.prepare(`
            SELECT COUNT(*) AS total FROM messages
            WHERE sender_id=? AND receiver_id=? AND read_at IS NULL
        `).get(id, me.id).total;

        return {
            friend: publicUser(friend),
            lastMessage: last ? last.content : "",
            lastMessageDate: last ? last.created_at : null,
            unread
        };
    }).filter(Boolean);

    results.sort((a,b) =>
        (b.lastMessageDate || "").localeCompare(a.lastMessageDate || "")
    );

    res.json(results);
});

// HISTORIQUE D'UNE CONVERSATION
app.get("/api/messages/:friendId", requireLogin, (req, res) => {
    const me = currentUser(req);
    const friend = users.find(u => u.id === req.params.friendId);

    if (!areFriends(me, friend))
        return res.status(403).json({ error: "Conversation non autorisée." });

    const messages = db.prepare(`
        SELECT id, sender_id, receiver_id, content, created_at, read_at
        FROM messages
        WHERE (sender_id=? AND receiver_id=?)
           OR (sender_id=? AND receiver_id=?)
        ORDER BY id ASC
        LIMIT 500
    `).all(me.id, friend.id, friend.id, me.id);

    db.prepare(`
        UPDATE messages SET read_at=CURRENT_TIMESTAMP
        WHERE sender_id=? AND receiver_id=? AND read_at IS NULL
    `).run(friend.id, me.id);

    res.json(messages);
});

// ENVOYER UN MESSAGE PRIVÉ
app.post("/api/messages/:friendId", requireLogin, (req, res) => {
    const me = currentUser(req);
    const friend = users.find(u => u.id === req.params.friendId);

    if (!areFriends(me, friend))
        return res.status(403).json({ error: "Vous devez être amis pour discuter." });

    const content = String(req.body.content || "").trim();

    if (!content || content.length > 2000)
        return res.status(400).json({ error: "Message invalide (maximum 2000 caractères)." });

    const result = db.prepare(`
        INSERT INTO messages (sender_id, receiver_id, content)
        VALUES (?, ?, ?)
    `).run(me.id, friend.id, content);

    const message = db.prepare(`
        SELECT id, sender_id, receiver_id, content, created_at, read_at
        FROM messages WHERE id=?
    `).get(Number(result.lastInsertRowid));

    io.to("user:" + friend.id).emit("private message", message);

    res.status(201).json(message);
});

// MARQUER LES MESSAGES COMME LUS
app.post("/api/messages/:friendId/read", requireLogin, (req, res) => {
    const me = currentUser(req);
    const friend = users.find(u => u.id === req.params.friendId);

    if (!areFriends(me, friend))
        return res.status(403).json({ error: "Accès interdit." });

    db.prepare(`
        UPDATE messages SET read_at=CURRENT_TIMESTAMP
        WHERE sender_id=? AND receiver_id=? AND read_at IS NULL
    `).run(friend.id, me.id);

    io.to("user:" + friend.id).emit("messages read", {
        readerId: me.id,
        friendId: friend.id
    });

    res.json({ message: "Messages marqués comme lus." });
});

// DÉCONNEXION
app.post("/api/logout", requireLogin, (req, res) => {
    req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.json({ message: "Déconnecté." });
    });
});

// SOCKET.IO
io.use((socket, next) => {
    if (socket.request.session.userId) return next();
    next(new Error("Connexion nécessaire."));
});

io.on("connection", socket => {
    const user = users.find(u => u.id === socket.request.session.userId);
    if (!user) return socket.disconnect(true);

    socket.join("user:" + user.id);

    socket.on("chat message", data => {
        if (!data || typeof data.message !== "string") return;

        const message = data.message.trim().slice(0, 2000);
        if (!message) return;

        io.emit("chat message", {
            username: user.username,
            message,
            date: new Date().toLocaleTimeString("fr-FR")
        });
    });

    console.log(user.username + " connecté.");
});

server.listen(3000, () => {
    console.log("🌴 MAYOTTE CHAT : http://localhost:3000");
});

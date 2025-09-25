import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import cors from "cors";
import { google } from "googleapis";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import multer from "multer";
import pg from "pg";
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';

dotenv.config();

// --- Cloudinary Configuration ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'awl_services',
        format: 'jpg',
        public_id: (req, file) => path.parse(file.originalname).name.replace(/\s+/g, '_'),
    },
});

const upload = multer({ storage: storage });

// --- PostgreSQL Database Setup ---
const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// --- Function to Create Tables and Seed Data ---
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS services (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                performer TEXT NOT NULL,
                duration INTEGER NOT NULL,
                price INTEGER NOT NULL,
                category TEXT,
                imageUrl TEXT,
                description TEXT
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS service_logs (
                id SERIAL PRIMARY KEY,
                username TEXT,
                action TEXT,
                service_id INTEGER,
                details TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        const catRes = await pool.query("SELECT COUNT(*) FROM categories");
        if (catRes.rows[0].count === "0") {
            console.log("No categories found, seeding default categories...");
            const defaultCategories = ['relaxation', 'beauty', 'aesthetics', 'hairtreatment', 'photography', 'rejuvenate'];
            for (const cat of defaultCategories) {
                await pool.query("INSERT INTO categories (name) VALUES ($1)", [cat]);
            }
        }
    } catch (err) {
        console.error("Error during database initialization:", err);
    }
}
initDB();

// --- Middleware and Setup ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

const auth = new google.auth.GoogleAuth({
    credentials: {
        type: "service_account",
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
        universe_domain: "googleapis.com",
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// --- Auth Functions & Routes ---
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    const token = authHeader.split(" ")[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        res.status(401).json({ error: "Invalid token" });
    }
}

app.post("/admin/login", (req, res) => {
    const { username, password } = req.body;
    const allowedUsers = [];
    for (let i = 1; i <= 10; i++) {
        const user = process.env[`AWLOUNGE_USER_${i}`];
        const pass = process.env[`AWLOUNGE_PASS_${i}`];
        const role = process.env[`AWLOUNGE_ROLE_${i}`] || "user";
        if (user && pass) {
            allowedUsers.push({ user, pass, role });
        }
    }
    const validUser = allowedUsers.find(u => u.user === username && u.pass === password);
    if (validUser) {
        const token = jwt.sign({ username: validUser.user, role: validUser.role }, JWT_SECRET, { expiresIn: "4h" });
        res.json({ success: true, token, username: validUser.user, role: validUser.role });
    } else {
        res.status(401).json({ success: false, error: "Invalid credentials" });
    }
});

async function logChange(username, action, serviceId, details) {
    try {
        await pool.query(
            "INSERT INTO service_logs (username, action, service_id, details) VALUES ($1, $2, $3, $4)",
            [username, action, serviceId, JSON.stringify(details)]
        );
    } catch (err) {
        console.error("Failed to log change:", err);
    }
}

// --- CATEGORY API ROUTES ---
app.get("/api/categories", async (req, res) => {
    try {
        const result = await pool.query("SELECT name FROM categories ORDER BY name");
        res.json(result.rows.map(row => row.name));
    } catch (error) {
        console.error('API Error fetching categories:', error);
        res.status(500).json({ error: "Failed to retrieve categories." });
    }
});

app.post("/api/categories", authenticate, async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: "Category name is required." });
    }
    try {
        await pool.query("INSERT INTO categories (name) VALUES ($1)", [name.toLowerCase().trim()]);
        res.json({ success: true, message: `Category '${name}' added.`});
    } catch (error) {
        console.error('API Error adding category:', error);
        res.status(500).json({ error: "Failed to add category. It may already exist." });
    }
});

// --- SERVICE API ROUTES ---
app.get("/api/services", async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const result = await pool.query("SELECT * FROM services ORDER BY category, name");
        res.json(result.rows);
    } catch (error) {
        console.error('API Error fetching services:', error);
        res.status(500).json({ error: "Failed to retrieve services." });
    }
});

app.get("/services", authenticate, async (req, res) => {
    try {
        let result;
        if (req.user && req.user.role && req.user.role.toLowerCase() === "admin") {
            result = await pool.query("SELECT * FROM services ORDER BY category, name");
        } else {
            result = await pool.query("SELECT * FROM services WHERE performer ILIKE $1 ORDER BY category, name", [`%${req.user.username}%`]);
        }
        res.json(result.rows);
    } catch (err) {
        console.error('Portal service fetch error:', err);
        res.status(500).json({ error: "Failed to fetch services for portal." });
    }
});

app.post("/services", authenticate, upload.single('image'), async (req, res) => {
    const { name, performer, duration, price, category, description } = req.body;
    const imageUrl = req.file ? req.file.path : null;
    try {
        const result = await pool.query(
            "INSERT INTO services (name, performer, duration, price, category, imageUrl, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            [name, performer, duration, price, category, imageUrl, description]
        );
        const newId = result.rows[0].id;
        await logChange(req.user.username, "ADD", newId, req.body);
        res.json({ success: true, id: newId });
    } catch (err) {
        console.error('Add service error:', err);
        res.status(500).json({ error: "Failed to add service." });
    }
});

app.put("/services/:id", authenticate, upload.single('image'), async (req, res) => {
    const { id } = req.params;
    const { name, performer, duration, price, category, description, existingImageUrl } = req.body;
    let imageUrl = req.file ? req.file.path : existingImageUrl;
    try {
        await pool.query(
            "UPDATE services SET name = $1, performer = $2, duration = $3, price = $4, category = $5, imageUrl = $6, description = $7 WHERE id = $8",
            [name, performer, duration, price, category, imageUrl, description, id]
        );
        await logChange(req.user.username, "EDIT", id, req.body);
        res.json({ success: true });
    } catch (err) {
        console.error('Update service error:', err);
        res.status(500).json({ error: "Failed to update service." });
    }
});

app.delete("/services/:id", authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const serviceRes = await pool.query("SELECT * FROM services WHERE id = $1", [id]);
        if (serviceRes.rows.length === 0) {
            return res.status(404).json({ error: "Service not found" });
        }
        await pool.query("DELETE FROM services WHERE id = $1", [id]);
        await logChange(req.user.username, "DELETE", id, serviceRes.rows[0]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete service error:', err);
        res.status(500).json({ error: "Failed to delete service." });
    }
});

// --- Booking and Payment Routes ---
app.post("/create-payment-intent", async (req, res) => {
    try {
        const { serviceId } = req.body;
        const serviceRes = await pool.query("SELECT * FROM services WHERE id = $1", [serviceId]);
        if (serviceRes.rows.length === 0) {
            return res.status(400).json({ error: "Service not found" });
        }
        const service = serviceRes.rows[0];
        const amount = Math.round(service.price * 0.25);
        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: "cad",
            description: `25% deposit for ${service.name}`
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error('Payment intent error:', err);
        res.status(500).json({ error: "Failed to create payment intent" });
    }
});

app.get("/freebusy/:calendarId", async (req, res) => {
    try {
        const { calendarId } = req.params;
        const { timeMin, timeMax } = req.query;
        const result = await calendar.freebusy.query({
            requestBody: { timeMin, timeMax, items: [{ id: calendarId }] },
        });
        res.json(result.data);
    } catch (err) {
        console.error('Free/busy error:', err);
        res.status(500).json({ error: "Failed to fetch availability" });
    }
});

app.post("/book/:calendarId", async (req, res) => {
    const { calendarId } = req.params;
    try {
        const { name, phone, email, service, performer, dateTime } = req.body;
        const startDateTime = new Date(dateTime);
        const serviceRes = await pool.query("SELECT duration FROM services WHERE name = $1 AND performer ILIKE $2", [service, `%${performer}%`]);
        const duration = serviceRes.rows[0]?.duration || 60;
        const endDateTime = new Date(startDateTime.getTime() + duration * 60 * 1000);
        const event = {
            summary: `Booking: ${name} - ${service}`,
            description: `Client: ${name}\nPhone: ${phone}\nEmail: ${email}\nService: ${service}\nProvider: ${performer}`,
            start: { dateTime: startDateTime.toISOString(), timeZone: "America/Toronto" },
            end: { dateTime: endDateTime.toISOString(), timeZone: "America/Toronto" }
        };
        await calendar.events.insert({ calendarId, requestBody: event });
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: "Your Appointment is Confirmed!",
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px; color: #333;"><div style="text-align: center; margin-bottom: 30px;"><img src="cid:logo" alt="AWL Logo" style="max-width: 150px; height: auto;"></div><h2 style="text-align: center; color: #2a2a2a;">Appointment Confirmed!</h2><p style="text-align: center;">Hi <strong>${name}</strong>,</p><p style="text-align: center;">Your appointment for <strong>${service}</strong> with <strong>${performer}</strong> is confirmed.</p><div style="background: #f7f7f7; padding: 15px; border-radius: 8px; margin: 20px 0;"><p style="margin: 5px 0;"><strong>Date & Time:</strong> ${startDateTime.toLocaleString('en-CA', { timeZone: 'America/Toronto', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true })}</p><p style="margin: 5px 0;"><strong>Provider:</strong> ${performer}</p><p style="margin: 5px 0;"><strong>Service:</strong> ${service}</p></div><hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;"><div style="text-align: center;"><img src="cid:banner" alt="AWL Banner" style="max-width: 350px; height: auto;"><br><p style="font-size: 14px; color: #777; text-align: center;">Aesthetics and Wellness Lounge<br>www.awlounge.ca<br>577 Dundas St, Woodstock, ON | 226-796-5138 | awl.jm2@gmail.com</p></div></div>`,
            attachments: [
                { filename: 'AWL_Logo.jpg', path: path.join(__dirname, 'public', 'AWL_Logo.jpg'), cid: 'logo' },
                { filename: 'AWL_Banner.jpg', path: path.join(__dirname, 'public', 'AWL_Banner.jpg'), cid: 'banner' }
            ]
        });
        console.log(`✅ Booking created and email sent for ${name} on ${startDateTime}`);
        res.json({ success: true, message: "Booking confirmed" });
    } catch (err) {
        console.error("Booking Error:", err);
        res.status(500).json({ error: "Failed to create booking" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
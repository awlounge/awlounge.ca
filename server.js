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

// --- Cloudinary, Multer, and PostgreSQL Setup (Unchanged) ---
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const storage = new CloudinaryStorage({ cloudinary: cloudinary, params: { folder: 'awl_services', format: 'jpg', public_id: (req, file) => path.parse(file.originalname).name.replace(/\s+/g, '_') } });
const upload = multer({ storage: storage });
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- Database Initialization (Unchanged) ---
async function initDB() { /* ... Unchanged ... */ }
initDB();

// --- Middleware and Setup (Unchanged) ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const auth = new google.auth.GoogleAuth({ /* ... Unchanged ... */ });
const calendar = google.calendar({ version: "v3", auth });
const transporter = nodemailer.createTransport({ /* ... Unchanged ... */ });

// --- HELPER FUNCTION TO FORMAT AND ADD CATEGORIES ---
async function ensureCategoryExists(categoryName) {
    if (!categoryName || typeof categoryName !== 'string' || categoryName.trim() === '') {
        return null; // Return null if category is invalid or empty
    }
    // Standardize the format: trim whitespace and capitalize each word
    const formattedName = categoryName.trim().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    
    try {
        // Use INSERT ... ON CONFLICT to add the category only if it doesn't already exist
        await pool.query(
            "INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
            [formattedName]
        );
        return formattedName; // Return the correctly formatted name
    } catch (error) {
        console.error("Error ensuring category exists:", error);
        return categoryName; // Fallback to original name on error
    }
}


// --- Auth Functions & Routes (Unchanged) ---
function authenticate(req, res, next) { /* ... Unchanged ... */ }
app.post("/admin/login", (req, res) => { /* ... Unchanged ... */ });
async function logChange(username, action, serviceId, details) { /* ... Unchanged ... */ }

// --- CATEGORY API ROUTES (Updated) ---
app.get("/api/categories", async (req, res) => {
    try {
        const result = await pool.query("SELECT name FROM categories ORDER BY name");
        res.json(result.rows.map(row => row.name));
    } catch (error) {
        res.status(500).json({ error: "Failed to retrieve categories." });
    }
});

app.post("/api/categories", authenticate, async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: "Category name is required." });
    }
    try {
        // Use the helper function to format and add the category
        const formattedName = await ensureCategoryExists(name);
        res.json({ success: true, message: `Category '${formattedName}' added.`});
    } catch (error) {
        res.status(500).json({ error: "Failed to add category. It may already exist." });
    }
});

app.delete("/api/categories", authenticate, async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: "Category name is required." });
    }
    try {
        const inUseCheck = await pool.query("SELECT id FROM services WHERE LOWER(category) = LOWER($1) LIMIT 1", [name.trim()]);
        if (inUseCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Failed to delete category. It might still be in use by some services.' });
        }
        const deleteResult = await pool.query("DELETE FROM categories WHERE LOWER(name) = LOWER($1)", [name.trim()]);
        if (deleteResult.rowCount === 0) {
             return res.status(404).json({ error: 'Category not found.' });
        }
        res.status(200).json({ success: true, message: 'Category deleted successfully.' });
    } catch (error) {
        res.status(500).json({ error: "Server error while deleting category." });
    }
});

// --- SERVICE API ROUTES (Updated) ---
app.get("/api/services", async (req, res) => { /* ... Unchanged ... */ });
app.get("/services", authenticate, async (req, res) => { /* ... Unchanged ... */ });

app.post("/services", authenticate, upload.single('image'), async (req, res) => {
    let { name, performer, duration, price, category, description } = req.body;
    const imageUrl = req.file ? req.file.path : null;
    try {
        // THIS IS THE FIX: Ensure the category exists and is formatted before saving the service
        const finalCategory = await ensureCategoryExists(category);

        const result = await pool.query(
            "INSERT INTO services (name, performer, duration, price, category, imageUrl, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            [name, performer, duration, price, finalCategory, imageUrl, description]
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
    let { name, performer, duration, price, category, description, existingImageUrl } = req.body;
    let imageUrl = req.file ? req.file.path : existingImageUrl;
    try {
        // THIS IS THE FIX: Ensure the category exists and is formatted before updating the service
        const finalCategory = await ensureCategoryExists(category);

        await pool.query(
            "UPDATE services SET name = $1, performer = $2, duration = $3, price = $4, category = $5, imageUrl = $6, description = $7 WHERE id = $8",
            [name, performer, duration, price, finalCategory, imageUrl, description, id]
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
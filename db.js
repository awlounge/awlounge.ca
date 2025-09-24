// db.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";

export async function initDB() {
  const db = await open({
    filename: "./services.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      performer TEXT NOT NULL,
      duration INTEGER NOT NULL,
      price INTEGER NOT NULL
    )
  `);

  const count = await db.get("SELECT COUNT(*) as count FROM services");
  if (count.count === 0) {
    const seedData = [
      { category: "relaxation", name: "Foot Reflexology - 45min", performer: "Jessa", duration: 45, price: 6000 },
      { category: "relaxation", name: "Hand Reflexology - 45min", performer: "Jessa", duration: 45, price: 6000 },
      { category: "relaxation", name: "Head-to-Toe Relaxation Package - 45min", performer: "Jessa", duration: 45, price: 7000 },
      { category: "relaxation", name: "Scalp & Shoulder Massage - 45min", performer: "Jessa", duration: 45, price: 5000 },
      { category: "beauty", name: "Special Event Makeover", performer: "Trechan", duration: 90, price: 10000 },
      { category: "beauty", name: "Brow Lamination - 60min", performer: "Maricel", duration: 60, price: 8000 },
      { category: "beauty", name: "Lash Extensions - Classic - 120min", performer: "Maricel", duration: 120, price: 12000 },
      { category: "beauty", name: "Lash Lift and Tint - 60min", performer: "Maricel", duration: 60, price: 7500 },
      { category: "aesthetics", name: "Manicure - 60min", performer: "Trechan", duration: 60, price: 6000 },
      { category: "aesthetics", name: "Pedicure - 60min", performer: "Trechan", duration: 60, price: 6500 },
      { category: "aesthetics", name: "Mani-Pedi - 120min", performer: "Trechan", duration: 120, price: 12000 },
      { category: "hair", name: "Hair Wash & Style - 90min", performer: "Maricel", duration: 90, price: 9000 },
      { category: "hair", name: "Hair Lamination - 120min", performer: "Maricel", duration: 120, price: 15000 },
      { category: "photography", name: "Solo Portrait Session - 30min", performer: "Jessa", duration: 30, price: 7000 },
      { category: "photography", name: "Group Portrait Session - 60min", performer: "Jessa", duration: 60, price: 12000 },
      { category: "rejuvenate", name: "Ayurvedic Scalp Massage / Swedish Combo - 120min", performer: "Mary-Ann", duration: 120, price: 14000 },
      { category: "rejuvenate", name: "Hot Stones Aromatherapy Massage - 120min", performer: "Mary-Ann", duration: 120, price: 15000 },
    ];

    for (const s of seedData) {
      await db.run(
        "INSERT INTO services (category, name, performer, duration, price) VALUES (?, ?, ?, ?, ?)",
        [s.category, s.name, s.performer, s.duration, s.price]
      );
    }
  }

  return db;
}

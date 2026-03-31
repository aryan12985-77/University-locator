import sqlite3
import json

# connect to database
conn = sqlite3.connect("campus.db")
cursor = conn.cursor()

# create table
cursor.execute("""
CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    building TEXT,
    floor TEXT,
    lat REAL,
    lng REAL
)
""")

# load JSON data
with open("data/locations.json") as f:
    data = json.load(f)

# insert data
for loc in data:
    cursor.execute("""
    INSERT INTO locations (name, building, floor, lat, lng)
    VALUES (?, ?, ?, ?, ?)
    """, (loc["name"], loc["building"], loc["floor"], loc["lat"], loc["lng"]))

conn.commit()
conn.close()

print("Database created successfully!")
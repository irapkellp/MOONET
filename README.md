# MOONET
MOONET - Short Video Social Platform and Rewards System
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "MOONET",
    message: "MOONET is running"
  });
});

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MOONET</title>
      <style>
        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: Arial, sans-serif;
          background: #080b1a;
          color: white;
          text-align: center;
        }

        header {
          padding: 24px 15px;
          background: #111735;
          border-bottom: 1px solid #29315c;
        }

        h1 {
          color: #a78bfa;
          font-size: 38px;
          margin: 0;
        }

        .hero {
          padding: 65px 20px;
        }

        .hero h2 {
          font-size: 32px;
        }

        .hero p {
          color: #c5c9dc;
          line-height: 1.7;
        }

        .moon {
          color: #facc15;
          font-weight: bold;
        }

        .button {
          display: inline-block;
          padding: 13px 25px;
          margin: 10px 5px;
          background: #7c3aed;
          color: white;
          text-decoration: none;
          border-radius: 10px;
          font-weight: bold;
        }

        .features {
          padding: 20px;
          display: grid;
          gap: 15px;
          max-width: 750px;
          margin: auto;
        }

        .card {
          padding: 20px;
          background: #111735;
          border: 1px solid #29315c;
          border-radius: 14px;
        }

        footer {
          padding: 25px;
          color: #9ca3af;
        }
      </style>
    </head>
    <body>
      <header>
        <h1>🌙 MOONET</h1>
        <p>Watch. Create. Earn.</p>
      </header>

      <main>
        <section class="hero">
          <h2>Welcome to MOONET</h2>
          <p>
            Discover short videos, share your creativity,
            and explore rewards.
          </p>
          <p class="moon">1 MOON = 10 RWF</p>
          <a class="button" href="/signup">Create Account</a>
          <a class="button" href="/login">Login</a>
        </section>

        <section class="features">
          <div class="card">
            <h3>🎬 Watch Videos</h3>
            <p>Discover entertaining short videos.</p>
          </div>

          <div class="card">
            <h3>🌙 MOON Wallet</h3>
            <p>Track your MOON rewards and transactions.</p>
          </div>

          <div class="card">
            <h3>💰 Earn Rewards</h3>
            <p>Explore eligible activities and rewards.</p>
          </div>
        </section>
      </main>

      <footer>
        MOONET &copy; ${new Date().getFullYear()}
      </footer>
    </body>
    </html>
  `);
});

app.get("/signup", (req, res) => {
  res.send("MOONET Sign Up page is coming next.");
});

app.get("/login", (req, res) => {
  res.send("MOONET Login page is coming next.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MOONET running on port ${PORT}`);
});

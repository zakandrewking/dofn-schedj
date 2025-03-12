const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const redis = require("redis");
const path = require("path");
require("dotenv").config();

// ----- Setup Redis Client -----
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
  socket: {
    tls: true,
    rejectUnauthorized: false,
  },
}); // connection to Upstash Redis with TLS enabled
redisClient.on("error", (err) => console.error("Redis error:", err));
// If needed, handle connecting auth or different host/port.

(async function initRedis() {
  // Connect to Redis
  await redisClient.connect();
})();

// ----- In-Redis Key for Our "Poll" -----
const POLL_KEY = "seattle_work_poll";

// ----- Create Express App -----
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (the front-end HTML/JS) from a "public" folder
// You can also place the final HTML snippet in "public/index.html"
app.use(express.static(path.join(__dirname, "public")));

// To parse JSON bodies
app.use(express.json());

// ----- 1) Ensure Poll Exists in Redis -----
async function ensurePollExists() {
  const poll = await redisClient.get(POLL_KEY);
  if (!poll) {
    // Create an initial poll with an empty array for userVotes
    const initialData = {
      id: "seat-22222-3333-4444-555555555555",
      title: "Seattle Work Get-Together",
      userVotes: [],
      // The old options array is kept for backward compatibility
      options: [
        { label: "2024-04-05", votes: 0 }, // Cherry Blossom Festival
        { label: "2024-04-12", votes: 0 }, // Tulip Festival
        { label: "2024-04-19", votes: 0 }, // Earth Day weekend
      ],
    };
    await redisClient.set(POLL_KEY, JSON.stringify(initialData));
    console.log("Initialized Seattle poll in Redis");
  } else {
    // Check if we need to update the structure for existing polls
    const pollData = JSON.parse(poll);
    if (!pollData.userVotes) {
      pollData.userVotes = [];
      await redisClient.set(POLL_KEY, JSON.stringify(pollData));
      console.log("Updated poll structure in Redis");
    }
  }
}

// ----- 2) Get Poll Route -----
app.get("/poll", async (req, res) => {
  try {
    const data = await redisClient.get(POLL_KEY);
    if (!data) {
      return res.status(404).json({ error: "Poll not found in Redis." });
    }

    const pollData = JSON.parse(data);

    // Calculate popular dates
    if (pollData.userVotes && pollData.userVotes.length > 0) {
      // Count occurrences of each date
      const dateCounts = {};
      pollData.userVotes.forEach((vote) => {
        vote.dates.forEach((date) => {
          dateCounts[date] = (dateCounts[date] || 0) + 1;
        });
      });

      // Convert to array and sort by count (descending)
      const popularDates = Object.entries(dateCounts)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5); // Top 5 dates

      pollData.popularDates = popularDates;
    }

    return res.json(pollData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error fetching poll." });
  }
});

// ----- 3) Submit User Dates -----
app.post("/poll/user-dates", async (req, res) => {
  const { userName, dates } = req.body;

  if (!userName || !dates || !Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({
      error:
        "Invalid submission. Please provide your name and at least one date.",
    });
  }

  try {
    const raw = await redisClient.get(POLL_KEY);
    if (!raw) return res.status(404).json({ error: "Poll not found." });

    const poll = JSON.parse(raw);

    // Check if this user already submitted (by name)
    const existingUserIndex = poll.userVotes.findIndex(
      (vote) => vote.userName.toLowerCase() === userName.toLowerCase()
    );

    if (existingUserIndex !== -1) {
      // Update existing user's dates
      poll.userVotes[existingUserIndex].dates = dates;
    } else {
      // Add new user votes
      poll.userVotes.push({
        id: Date.now().toString(), // simple unique ID
        userName,
        dates,
      });
    }

    await redisClient.set(POLL_KEY, JSON.stringify(poll));

    // Notify all connected Socket.IO clients
    io.emit("pollUpdated");

    res.json({ message: "Availability submitted successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error submitting availability." });
  }
});

// ----- 4) Delete User Dates -----
app.delete("/poll/user-dates/:userName", async (req, res) => {
  const { userName } = req.params;

  if (!userName) {
    return res.status(400).json({
      error: "Invalid request. Please provide a username.",
    });
  }

  try {
    const raw = await redisClient.get(POLL_KEY);
    if (!raw) return res.status(404).json({ error: "Poll not found." });

    const poll = JSON.parse(raw);

    // Find the user by name
    const userIndex = poll.userVotes.findIndex(
      (vote) => vote.userName.toLowerCase() === userName.toLowerCase()
    );

    if (userIndex === -1) {
      return res.status(404).json({ error: "User not found in the poll." });
    }

    // Remove the user from the array
    poll.userVotes.splice(userIndex, 1);

    await redisClient.set(POLL_KEY, JSON.stringify(poll));

    // Notify all connected Socket.IO clients
    io.emit("pollUpdated");

    res.json({ message: "User dates successfully deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error deleting user dates." });
  }
});

// Keep the old endpoints for backward compatibility

// ----- Add New Date to Poll (Legacy) -----
app.post("/poll/date", async (req, res) => {
  const { newDate } = req.body; // the date string from the client
  if (!newDate) {
    return res.status(400).json({ error: "No date provided." });
  }
  try {
    const raw = await redisClient.get(POLL_KEY);
    if (!raw) return res.status(404).json({ error: "Poll not found." });
    const poll = JSON.parse(raw);

    poll.options.push({ label: newDate, votes: 0 });
    await redisClient.set(POLL_KEY, JSON.stringify(poll));

    // Notify all connected Socket.IO clients to re-fetch data
    io.emit("pollUpdated");

    res.json({ message: "Date added successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error adding date." });
  }
});

// ----- Vote on an Option (Legacy) -----
app.post("/poll/vote", async (req, res) => {
  const { optionIndex } = req.body;
  try {
    const raw = await redisClient.get(POLL_KEY);
    if (!raw) return res.status(404).json({ error: "Poll not found." });
    const poll = JSON.parse(raw);

    if (optionIndex < 0 || optionIndex >= poll.options.length) {
      return res.status(400).json({ error: "Invalid option index." });
    }
    poll.options[optionIndex].votes++;

    await redisClient.set(POLL_KEY, JSON.stringify(poll));

    // Notify all clients
    io.emit("pollUpdated");

    res.json({ message: "Vote registered." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error casting vote." });
  }
});

// ----- Socket.IO Real-time -----
io.on("connection", (socket) => {
  console.log("A client connected.");

  socket.on("disconnect", () => {
    console.log("Client disconnected.");
  });
});

// ----- Start Server -----
const PORT = process.env.PORT || 3002;
server.listen(PORT, async () => {
  await ensurePollExists();
  console.log(`Server running on http://localhost:${PORT}`);
});

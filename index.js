require("dotenv").config();
const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});


app.use(cors());
app.use(express.json());

// TURN credentials endpoint — fetches ICE servers from Metered.ca
app.get("/api/turn-credentials", async (req, res) => {
  try {
    const apiKey = process.env.METERED_API_KEY;
    if (!apiKey) {
      // Fallback: return free public STUN + TURN servers
      return res.json([
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
      ]);
    }
    const response = await axios.get(
      `https://${process.env.METERED_DOMAIN || "vi-meet.metered.live"}/api/v1/turn/credentials?apiKey=${apiKey}`
    );
    res.json(response.data);
  } catch (error) {
    console.error("Error fetching TURN credentials:", error.message);
    // Fallback to free public servers on error
    res.json([
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
    ]);
  }
});

app.use(express.static(path.resolve(__dirname, "../client")));

app.get(/.*/, (req, res) => {
  res.sendFile(path.resolve(__dirname, "../client", "index.html"));
});


app.use((req, res, next) => {
  console.log("Request received:", req.path);
  next();
});


const generateRoomId = () => {
  const generateGroup = () =>
    Math.random().toString(36).substring(2, 5); 
  return `${generateGroup()}-${generateGroup()}-${generateGroup()}`;
};

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.emit("user-connection", io.engine.clientsCount);

  socket.on("create-room", (callback) => {
    const roomId = generateRoomId();
    socket.join(roomId);
    console.log(`Room created: ${roomId}`);
    callback(roomId);
  });

  socket.on("server-cold-start", (message) => {
    console.log(message);
    socket.emit("server-started", "Server is online");
  })

  socket.on("user-connection-room",({userRoomId, userName})=>{
    socket.join(userRoomId);
    console.log(`User connected to room: ${userRoomId}`);
    socket.emit("user-has-connected", userName)
    socket.to(userRoomId).emit("user-joined", userName);
  });

  socket.on("user-message-send", ({ userRoomId, userMessage, roomUserName, userMessageTime }) => {
    socket.to(userRoomId).emit("user-message-receive", {userMessage, roomUserName}); 
    console.log("User message sent", { userMessage, userRoomId, roomUserName, userMessageTime });
  });
  
  // WebRTC signaling relays
  // Offer from A -> deliver to target B
  socket.on("webrtc-offer", ({ roomId, offer, from, to }) => {
    try {
      io.to(to).emit("webrtc-offer", { offer, from });
    } catch (e) {
      console.warn("Error relaying webrtc-offer", e);
    }
  });

  // Answer from B -> deliver to original offerer A
  socket.on("webrtc-answer", ({ roomId, answer, from, to }) => {
    try {
      io.to(to).emit("webrtc-answer", { answer, from });
    } catch (e) {
      console.warn("Error relaying webrtc-answer", e);
    }
  });

  // ICE candidates between peers
  socket.on("webrtc-candidate", ({ roomId, candidate, from, to }) => {
    try {
      io.to(to).emit("webrtc-candidate", { candidate, from });
    } catch (e) {
      console.warn("Error relaying webrtc-candidate", e);
    }
  });

  // Media state broadcast (mic/camera toggles)
  socket.on("media-state-changed", ({ roomId, isCameraOn, isAudioOn }) => {
    try {
      socket.to(roomId).emit("media-state-changed", { socketId: socket.id, isCameraOn, isAudioOn });
    } catch (e) {
      console.warn("Error broadcasting media-state-changed", e);
    }
  });

  socket.on("leave-room", (roomId)=>{
    socket.leave(roomId);
    socket.to(roomId).emit("user-left", socket.id);
    console.log(`User left room: ${roomId}`);
  })

  socket.on("disconnect", () => {
    console.log("A user disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 4001; 
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const firebase = require("firebase-admin");
const cron = require("node-cron");
const multer = require("multer"); // Dùng để xử lý upload file

const app = express();

const WS_PORT = 8888;
const HTTP_PORT = 8000;

const wsServer = new WebSocket.Server({ port: WS_PORT }, () =>
  console.log(`WS Server is listening at ${WS_PORT}`)
);

// Initialize Firebase
firebase.initializeApp({
  credential: firebase.credential.cert(
    require("./key.json") // Make sure this path is relative to your project folder
  ),
  storageBucket: "esp32cam-4dbf9.appspot.com",
});
const bucket = firebase.storage().bucket();

let connectedClients = [];

// WebSocket handling video streaming
wsServer.on("connection", (ws, req) => {
  console.log("Connected");
  connectedClients.push(ws);

  ws.on("message", (data) => {
    connectedClients.forEach((ws, i) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
        // Append video data to a temporary file
        fs.appendFileSync("video_stream_temp.mp4", data);
      } else {
        connectedClients.splice(i, 1);
      }
    });
  });
});

app.get("/client", (req, res) =>
  res.sendFile(path.resolve(__dirname, "./client.html"))
);

app.listen(HTTP_PORT, () =>
  console.log(`HTTP server listening at ${HTTP_PORT}`)
);

// Schedule to upload the video to Firebase every minute and delete the old file
cron.schedule("*/1 * * * *", () => {
  console.log("Uploading video to Firebase...");
  const videoFile = "video_stream_temp.mp4";

  // Check if video file exists
  if (fs.existsSync(videoFile)) {
    const blob = bucket.file(`videos/${Date.now()}.mp4`);
    const blobStream = blob.createWriteStream({
      metadata: {
        contentType: "video/mp4",
      },
    });

    
    // Read the temporary file and upload to Firebase
    fs.createReadStream(videoFile)
      .pipe(blobStream)
      .on("error", (err) => {
        console.error("Error uploading video:", err);
      })
      .on("finish", () => {
        console.log("Video uploaded successfully");

        // Delete the temporary video file after uploading
        fs.unlink(videoFile, (err) => {
          if (err) {
            console.error("Error deleting temporary video file:", err);
          } else {
            console.log("Temporary video file deleted.");
          }
        });
      });
  } else {
    console.log("No video file found to upload.");
  }
});

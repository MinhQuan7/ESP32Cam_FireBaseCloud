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
    require("./key.json") // Ensure this path is relative to your project folder
  ),
  storageBucket: "esp32cam-4dbf9.appspot.com",
});
const bucket = firebase.storage().bucket();

let connectedClients = [];

// Function to create a unique directory
function createDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// WebSocket handling video streaming
wsServer.on("connection", (ws, req) => {
  console.log("Connected");
  connectedClients.push(ws);

  ws.on("message", (data) => {
    connectedClients.forEach((ws, i) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);

        // Create a unique folder based on timestamp
        const folderName = `video_${Date.now()}`;
        const folderPath = path.join(__dirname, folderName);

        // Create directory for the current stream
        createDirectory(folderPath);

        // Write the video stream to a new file inside the unique folder
        const videoFilePath = path.join(folderPath, `video_stream.mp4`);
        fs.appendFileSync(videoFilePath, data);
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

// Schedule to upload the video to Firebase every minute and delete the old folder
cron.schedule("*/1 * * * *", () => {
  console.log("Uploading video to Firebase...");

  // Scan for folders that store video files
  fs.readdir(__dirname, (err, folders) => {
    if (err) {
      console.error("Error reading directories:", err);
      return;
    }

    folders.forEach((folder) => {
      const folderPath = path.join(__dirname, folder);

      // Check if it's a folder and contains video files
      if (fs.statSync(folderPath).isDirectory()) {
        const videoFile = path.join(folderPath, "video_stream.mp4");

        // Check if the video file exists in the folder
        if (fs.existsSync(videoFile)) {
          const blob = bucket.file(`videos/${folder}_${Date.now()}.mp4`);
          const blobStream = blob.createWriteStream({
            metadata: {
              contentType: "video/mp4",
            },
          });

          // Upload video to Firebase
          fs.createReadStream(videoFile)
            .pipe(blobStream)
            .on("error", (err) => {
              console.log("Error uploading video:", err);
            })
            .on("finish", () => {
              console.log(`Video from folder ${folder} uploaded successfully`);

              // Delete the folder after upload
              fs.rmdir(folderPath, { recursive: true }, (err) => {
                if (err) {
                  console.error("Error deleting folder:", err);
                } else {
                  console.log(`Folder ${folder} deleted after upload.`);
                }
              });
            });
        }
      }
    });
  });
});

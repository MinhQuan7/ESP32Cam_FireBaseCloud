const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const firebase = require("firebase-admin");
const cron = require("node-cron");
const ffmpeg = require("fluent-ffmpeg");

const ffmpegPath =
  "C:/Users/QuanLe/ffmpeg-7.0.2-essentials_build/bin/ffmpeg.exe"; // Thay đường dẫn này thành đường dẫn tới ffmpeg trên hệ thống của bạn
ffmpeg.setFfmpegPath(ffmpegPath); // Cấu hình đường dẫn ffmpeg

const app = express();

const WS_PORT = 8888;
const HTTP_PORT = 8000;

const wsServer = new WebSocket.Server({ port: WS_PORT }, () =>
  console.log(`WS Server is listening at ${WS_PORT}`)
);

// Initialize Firebase
firebase.initializeApp({
  credential: firebase.credential.cert(
    require("./key.json") // Đảm bảo đường dẫn đúng tới key Firebase
  ),
  storageBucket: "esp32cam-4dbf9.appspot.com",
});
const bucket = firebase.storage().bucket();

let connectedClients = [];
let currentFolderName = ""; // Folder hiện tại để lưu video
let isUploading = false; // Kiểm tra trạng thái upload

// Function to create a unique directory
function createDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Function to generate a new folder name
function generateNewFolder() {
  return `video_${Date.now()}`;
}

// WebSocket xử lý streaming video
wsServer.on("connection", (ws, req) => {
  console.log("Connected");
  ws.binaryType = "arraybuffer";
  connectedClients.push(ws);

  if (!currentFolderName) {
    // Tạo folder mới nếu chưa có
    currentFolderName = generateNewFolder();
    createDirectory(path.join(__dirname, currentFolderName));
  }

  ws.on("message", (data) => {
    connectedClients.forEach((ws, i) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);

        // Chuyển đổi ArrayBuffer thành Buffer
        const bufferData = Buffer.from(data);

        // Ghi dữ liệu stream vào file mới trong thư mục
        const videoFilePath = path.join(
          __dirname,
          currentFolderName,
          `video_stream.mp4`
        );
        const writeStream = fs.createWriteStream(videoFilePath, { flags: "a" });
        writeStream.write(bufferData);
        writeStream.end();
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

// Function to handle the upload process (Every 1 minute)
function handleUpload() {
  if (isUploading || !currentFolderName) return; // Kiểm tra nếu đang upload hoặc chưa có folder

  const folderPath = path.join(__dirname, currentFolderName);
  const videoFile = path.join(folderPath, "video_stream.mp4");

  // Kiểm tra xem file video có tồn tại không
  if (fs.existsSync(videoFile)) {
    isUploading = true; // Đặt trạng thái upload là true

    // Xử lý video qua ffmpeg để đảm bảo video hợp lệ
    const processedFile = path.join(folderPath, `processed_video.mp4`);
    ffmpeg(videoFile)
      .output(processedFile)
      .on("end", function () {
        console.log("File processed successfully, ready for upload.");

        // Upload video đã xử lý lên Firebase
        const blob = bucket.file(
          `videos/${currentFolderName}_${Date.now()}.mp4`
        );
        const blobStream = blob.createWriteStream({
          metadata: {
            contentType: "video/mp4",
          },
        });

        // Đọc file đã xử lý và upload lên Firebase
        fs.createReadStream(processedFile)
          .pipe(blobStream)
          .on("error", (err) => {
            console.log("Error uploading video:", err);
            isUploading = false; // Đặt lại trạng thái
          })
          .on("finish", () => {
            console.log(
              `Video from folder ${currentFolderName} uploaded successfully`
            );
            isUploading = false;
          });
      })
      .on("error", function (err) {
        console.log("Error processing video with ffmpeg:", err.message);
        isUploading = false; // Đặt lại trạng thái
      })
      .run(); // Bắt đầu xử lý video bằng ffmpeg
  }
}

// Function to handle the deletion of the oldest folder (Every 10 minutes)
function handleDeleteOldestFolder() {
  fs.readdir(__dirname, (err, folders) => {
    if (err) {
      console.error("Error reading directories:", err);
      return;
    }

    // Lọc chỉ các thư mục chứa video
    const videoFolders = folders.filter((folder) =>
      folder.startsWith("video_")
    );

    if (videoFolders.length > 0) {
      // Sắp xếp thư mục theo thời gian tạo (cũ nhất trước)
      const oldestFolder = videoFolders.sort()[0];
      const folderPath = path.join(__dirname, oldestFolder);

      // Xóa thư mục cũ nhất
      fs.rm(folderPath, { recursive: true }, (err) => {
        if (err) {
          console.error("Error deleting folder:", err);
        } else {
          console.log(`Oldest folder ${oldestFolder} deleted.`);
        }
      });
    } else {
      console.log("No video folders to delete.");
    }
  });
}



// Sử dụng cron để chạy upload mỗi 1 phút
cron.schedule("*/1 * * * *", () => {
  console.log("Checking for video upload...");
  handleUpload();
});

// Sử dụng cron để chạy xóa thư mục cũ nhất mỗi 10 phút
cron.schedule("*/10 * * * *", () => {
  console.log("Checking for folder deletion...");
  handleDeleteOldestFolder();
});

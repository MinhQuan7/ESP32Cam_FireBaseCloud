const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const firebase = require("firebase-admin");
const cron = require("node-cron");
const ffmpeg = require("fluent-ffmpeg"); // Thêm ffmpeg để xử lý video

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

// Function to create a unique directory
function createDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// WebSocket xử lý streaming video
wsServer.on("connection", (ws, req) => {
  console.log("Connected");
  connectedClients.push(ws);

  // Tạo một thư mục dựa trên timestamp để lưu trữ video
  const folderName = `video_${Date.now()}`;
  const folderPath = path.join(__dirname, folderName);

  // Tạo thư mục cho luồng stream hiện tại
  createDirectory(folderPath);

  const videoFilePath = path.join(folderPath, `video_stream.mp4`);
  const writeStream = fs.createWriteStream(videoFilePath, { flags: "a" });

  ws.on("message", (data) => {
    // Kiểm tra nếu dữ liệu là binary
    if (Buffer.isBuffer(data)) {
      connectedClients.forEach((ws, i) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data); // Gửi dữ liệu tới tất cả các clients

          // Ghi dữ liệu stream vào file
          writeStream.write(data);
        } else {
          connectedClients.splice(i, 1);
        }
      });
    } else {
      console.error("Received non-binary data, discarding...");
    }
  });

  ws.on("close", () => {
    writeStream.end(); // Kết thúc ghi file khi kết nối WebSocket đóng
  });

  ws.on("error", (error) => {
    console.error(`WebSocket error: ${error.message}`);
  });
});

app.get("/client", (req, res) =>
  res.sendFile(path.resolve(__dirname, "./client.html"))
);

app.listen(HTTP_PORT, () =>
  console.log(`HTTP server listening at ${HTTP_PORT}`)
);

// Định kỳ upload video lên Firebase và xóa thư mục cũ sau 1 phút
cron.schedule("*/1 * * * *", () => {
  console.log("Uploading video to Firebase...");

  // Tìm các thư mục chứa video
  fs.readdir(__dirname, (err, folders) => {
    if (err) {
      console.error("Error reading directories:", err);
      return;
    }

    folders.forEach((folder) => {
      const folderPath = path.join(__dirname, folder);

      // Kiểm tra xem đây có phải là thư mục chứa video không
      if (fs.statSync(folderPath).isDirectory()) {
        const videoFile = path.join(folderPath, "video_stream.mp4");

        // Kiểm tra xem file video có tồn tại không
        if (fs.existsSync(videoFile)) {
          // Xử lý video qua ffmpeg để đảm bảo video hợp lệ
          const processedFile = path.join(folderPath, `processed_video.mp4`);
          ffmpeg(videoFile)
            .output(processedFile)
            .on("end", function () {
              console.log("File processed successfully, ready for upload.");

              // Upload video đã xử lý lên Firebase
              const blob = bucket.file(`videos/${folder}_${Date.now()}.mp4`);
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
                })
                .on("finish", () => {
                  console.log(
                    `Video from folder ${folder} uploaded successfully`
                  );

                  // Xóa thư mục sau khi upload
                  fs.rmdir(folderPath, { recursive: true }, (err) => {
                    if (err) {
                      console.error("Error deleting folder:", err);
                    } else {
                      console.log(`Folder ${folder} deleted after upload.`);
                    }
                  });
                });
            })
            .on("error", function (err) {
              console.log("Error processing video with ffmpeg:", err.message);
            })
            .run(); // Bắt đầu xử lý video bằng ffmpeg
        }
      }
    });
  });
});

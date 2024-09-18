const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const firebase = require("firebase-admin");
const cron = require("node-cron");
const ffmpeg = require("fluent-ffmpeg");

//uuidv4 là lib giúp generate ra access token để xem videos
const { v4: uuidv4 } = require("uuid");

const ffmpegPath =
  "C:/Users/QuanLe/ffmpeg-7.0.2-essentials_build/bin/ffmpeg.exe";
ffmpeg.setFfmpegPath(ffmpegPath); // Cấu hình đường dẫn ffmpeg

const app = express();

const WS_PORT = 8888;
const HTTP_PORT = 8000;

const wsServer = new WebSocket.Server({ port: WS_PORT }, () =>
  console.log(`WS Server is listening at ${WS_PORT}`)
);

// Initialize Firebase
firebase.initializeApp({
  credential: firebase.credential.cert(require("./key.json")),
  storageBucket: "esp32cam-4dbf9.appspot.com",
});
const bucket = firebase.storage().bucket();

let connectedClients = [];
let currentFolderName = ""; // Folder hiện tại để lưu video
let isUploading = false; // Kiểm tra trạng thái upload
let recordingTimeout = null; // Để kiểm soát thời gian ghi
let videoBuffer = []; // Buffer để lưu dữ liệu video (dùng để trích xuất)
const bufferLimit = 32 * 20; // Giới hạn buffer lưu 30 giây (20 frames/giây)

let isEmergency = false; // Biến đánh dấu khi có yêu cầu khẩn cấp

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

// Start recording video
function startRecording() {
  currentFolderName = generateNewFolder();
  createDirectory(path.join(__dirname, currentFolderName));

  console.log("Started recording video.");

  recordingTimeout = setTimeout(() => {
    console.log("2 minutes recording finished, stopping and uploading.");
    stopRecording();
  }, 120000); // 2 phút
}

// Stop recording video and handle upload
function stopRecording() {
  if (recordingTimeout) {
    clearTimeout(recordingTimeout);
  }
  console.log("Uploading video to Firebase Cloud....");
  handleUploadAndDeletion();
}

//_____________ WebSocket xử lý streaming video________________
wsServer.on("connection", (ws, req) => {
  console.log("Connected");
  ws.binaryType = "arraybuffer";
  connectedClients.push(ws);

  //______________Ưu tiên ghi videos khi nhận tín hiệu khẩn cấp_______________
  if (!currentFolderName && !isEmergency) {
    startRecording(); // Bắt đầu ghi nếu không phải tình huống khẩn cấp
  }
  ws.on("message", (data) => {
    // Khi isEmergency, bỏ qua ghi video nhưng vẫn tiếp tục streaming
    if (!isEmergency) {
      // Thêm dữ liệu vào buffer (lưu 10 giây trước)
      videoBuffer.push(data);
      if (videoBuffer.length > bufferLimit) {
        videoBuffer.shift(); // Xóa phần tử cũ nhất nếu vượt quá giới hạn
      }

      // Ghi dữ liệu stream vào file mới trong thư mục
      const bufferData = Buffer.from(data);
      const videoFilePath = path.join(
        __dirname,
        currentFolderName,
        `video_stream.mp4`
      );
      const writeStream = fs.createWriteStream(videoFilePath, { flags: "a" });
      writeStream.write(bufferData);
      writeStream.end();
    }

    // Luôn thực hiện việc truyền dữ liệu qua WebSocket (streaming)
    connectedClients.forEach((ws, i) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
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

// Xử lý upload video sau khi dừng ghi
function handleUploadAndDeletion() {
  if (isUploading || !currentFolderName || isEmergency) return;

  const folderPath = path.join(__dirname, currentFolderName);
  const videoFile = path.join(folderPath, "video_stream.mp4");

  if (fs.existsSync(videoFile)) {
    isUploading = true;

    const processedFile = path.join(folderPath, `processed_video.mp4`);
    ffmpeg(videoFile)
      .output(processedFile)
      .on("end", function () {
        console.log("File processed successfully, ready for upload.");

        const blob = bucket.file(
          `videos/${currentFolderName}_${Date.now()}.mp4`
        );
        const blobStream = blob.createWriteStream({
          metadata: {
            contentType: "video/mp4",
          },
        });

        fs.createReadStream(processedFile)
          .pipe(blobStream)
          .on("error", (err) => {
            console.log("Error uploading video:", err);
            isUploading = false;
          })
          .on("finish", () => {
            console.log(
              `Video from folder ${currentFolderName} uploaded successfully`
            );
            currentFolderName = "";
            isUploading = false;
            if (!isEmergency) {
              startRecording();
            }
          });
      })
      .on("error", function (err) {
        console.log("Error processing video with ffmpeg:", err.message);
        isUploading = false;
      })
      .run();
  }
}

//______________________New version for optimize extractVideo_______________________
function extractVideo() {
  console.log("Extracting video...");

  // Đánh dấu trạng thái khẩn cấp
  isEmergency = true;

  const folderName = `extracted_video_${Date.now()}`;
  const folderPath = path.join(__dirname, folderName);
  createDirectory(folderPath);

  const videoFilePath = path.join(folderPath, `extracted_video.mp4`);
  const writeStream = fs.createWriteStream(videoFilePath);

  // Ghi buffer (10 giây trước khi bấm nút)
  const tenSecondsBefore = videoBuffer.slice(-10 * 30); // 10 giây trước khi bấm (30 frame/giây)

  console.log(
    `Số lượng frames trong buffer trước khi trích xuất: ${tenSecondsBefore.length}`
  );

  tenSecondsBefore.forEach((frame, index) => {
    console.log(`Ghi frame ${index} (10 giây trước) vào video`);
    writeStream.write(Buffer.from(frame));
  });

  // Bắt đầu ghi dữ liệu sau khi bấm nút
  const startTime = Date.now();
  console.log("Start record videos after press button");
  const recordAfterPress = setInterval(() => {
    if (Date.now() - startTime > 30000) {
      // Sau 30 giây kể từ khi bấm
      clearInterval(recordAfterPress);

      stopRecording(); // Ngừng ghi video chính sau 30 giây
      console.log("Stop Recording videos after 30s");
      writeStream.end();

      console.log("Video extraction completed.");

      // Upload video trích xuất lên Firebase
      processAndUploadVideo(folderPath, `extracted_video.mp4`);

      // Sau khi hoàn thành, tiếp tục quy trình ghi thông thường
      isEmergency = false;
      startRecording();
    } else {
      // Ghi thêm dữ liệu đang stream sau khi bấm nút
      if (videoBuffer.length > 0) {
        const frame = videoBuffer.shift(); // Lấy khung hình mới từ buffer
        writeStream.write(Buffer.from(frame));
      }
    }
  }, 1000 / 20); // Ghi 20 khung hình mỗi giây
}

//_____________________________End extract Videos______________________
// Upload video sau khi trích xuất
function processAndUploadVideo(folderPath, videoFileName) {
  const videoFile = path.join(folderPath, videoFileName);
  const processedFile = path.join(folderPath, `processed_${videoFileName}`);

  ffmpeg(videoFile)
    .output(processedFile)
    .on("end", function () {
      console.log("File processed successfully, ready for upload.");
      const blob = bucket.file(`videos/${processedFile}_${Date.now()}.mp4`);

      // Tạo access token
      const options = {
        metadata: {
          contentType: "video/mp4",
          // Cấp access token để xem video
          metadata: {
            firebaseStorageDownloadTokens: uuidv4(), // Sử dụng thư viện uuid để tạo token duy nhất
          },
        },
      };

      // Upload video lên Firebase
      const blobStream = blob.createWriteStream(options);
      fs.createReadStream(processedFile)
        .pipe(blobStream)
        .on("error", (err) => {
          console.log("Error uploading video:", err);
        })
        .on("finish", () => {
          console.log(`Video from ${processedFile} uploaded successfully`);
        });
    })
    .on("error", function (err) {
      console.log("Error processing video with ffmpeg:", err.message);
    })
    .run();
}

// Xử lý khi ESP32 Cam gửi yêu cầu (ưu tiên trích xuất)
app.get("/esp32Capture", (req, res) => {
  console.log("Received capture request from ESP32 Cam");
  // Ngay lập tức ưu tiên trích xuất video (10 giây trước và sau)
  extractVideo();
  res.send("Capture request received");
});

// Phát tín hiệu tới tất cả client qua WebSocket
function broadcastToClients(data) {
  connectedClients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

// Cron xóa video cũ nhất mỗi 10 phút
cron.schedule("*/10 * * * *", () => {
  console.log("Deleting oldest video...");
  deleteOldestVideo();
});

function deleteOldestVideo() {
  const videoDir = __dirname;

  fs.readdir(videoDir, (err, files) => {
    if (err) {
      console.error("Error reading directory:", err);
      return;
    }

    const videoFolders = files.filter((file) => file.startsWith("video_"));

    if (videoFolders.length === 0) {
      console.log("No video folders to delete.");
      return;
    }

    const oldestFolder = videoFolders.reduce((oldest, folder) => {
      const oldestTime = parseInt(oldest.split("_")[1]);
      const currentTime = parseInt(folder.split("_")[1]);
      return currentTime < oldestTime ? folder : oldest;
    });

    const folderPath = path.join(videoDir, oldestFolder);
    fs.rm(folderPath, { recursive: true }, (err) => {
      if (err) {
        console.error("Error deleting folder:", err);
      } else {
        console.log(`Oldest video folder ${oldestFolder} deleted.`);
      }
    });
  });
}

const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const firebase = require("firebase-admin");
const cron = require("node-cron");
const ffmpeg = require("fluent-ffmpeg");

const ffmpegPath = "C:/Users/QuanLe/ffmpeg-7.0.2-essentials_build/bin/ffmpeg.exe"; // Đường dẫn tới ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath); // Cấu hình đường dẫn ffmpeg

const app = express();

const WS_PORT = 8888;
const HTTP_PORT = 8000;

const wsServer = new WebSocket.Server({ port: WS_PORT }, () =>
  console.log(`WS Server is listening at ${WS_PORT}`)
);

// Initialize Firebase
firebase.initializeApp({
  credential: firebase.credential.cert(require("./key.json")), // Đảm bảo đường dẫn đúng tới key Firebase
  storageBucket: "esp32cam-4dbf9.appspot.com",
});
const bucket = firebase.storage().bucket();

let connectedClients = [];
let currentFolderName = ""; // Folder hiện tại để lưu video
let isUploading = false; // Kiểm tra trạng thái upload
let recordingTimeout = null; // Để kiểm soát thời gian ghi
let videoBuffer = []; // Buffer để lưu dữ liệu video (dùng để trích xuất)
const bufferLimit = 10 * 30; // Giới hạn buffer lưu 10 giây (30 frames/giây)
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

// WebSocket xử lý streaming video
wsServer.on("connection", (ws, req) => {
  console.log("Connected");
  ws.binaryType = "arraybuffer";
  connectedClients.push(ws);

  if (!currentFolderName && !isEmergency) {
    startRecording(); // Bắt đầu ghi khi có kết nối nếu không phải tình huống khẩn cấp
  }

  ws.on("message", (data) => {
    if (isEmergency) return; // Bỏ qua dữ liệu thông thường nếu đang trong tình huống khẩn cấp

    // Thêm dữ liệu vào buffer (lưu 10 giây trước)
    videoBuffer.push(data);
    if (videoBuffer.length > bufferLimit) {
      videoBuffer.shift(); // Xóa phần tử cũ nhất nếu vượt quá giới hạn
    }

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

// Function to handle the upload process
function handleUploadAndDeletion() {
  if (isUploading || !currentFolderName || isEmergency) return; // Không upload khi đang xử lý khẩn cấp

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
            // Đặt lại biến currentFolderName để tạo folder mới cho lần streaming tiếp theo
            currentFolderName = "";
            isUploading = false;
            if (!isEmergency) {
              startRecording(); // Tiếp tục ghi khi không có yêu cầu khẩn cấp
            }
          });
      })
      .on("error", function (err) {
        console.log("Error processing video with ffmpeg:", err.message);
        isUploading = false; // Đặt lại trạng thái
      })
      .run(); // Bắt đầu xử lý video bằng ffmpeg
  }
}

// Function để trích xuất video từ buffer
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
  videoBuffer.forEach((frame) => {
    writeStream.write(Buffer.from(frame));
  });

  // Ghi thêm dữ liệu 10 giây sau khi bấm nút
  setTimeout(() => {
    stopRecording(); // Ngừng ghi video chính sau 10 giây
    writeStream.end();
    console.log("Video extraction completed.");

    // Upload video trích xuất lên Firebase
    processAndUploadVideo(folderPath, `extracted_video.mp4`);

    // Sau khi hoàn thành, tiếp tục quy trình ghi thông thường
    isEmergency = false;
    startRecording();
  }, 10000);
}

// Function to handle video upload after extraction
function processAndUploadVideo(folderPath, videoFileName) {
  const videoFile = path.join(folderPath, videoFileName);
  const processedFile = path.join(folderPath, `processed_${videoFileName}`);

  ffmpeg(videoFile)
    .output(processedFile)
    .on("end", function () {
      console.log("File processed successfully, ready for upload.");
      const blob = bucket.file(`videos/${folderPath}_${Date.now()}.mp4`);
      const blobStream = blob.createWriteStream({ metadata: { contentType: "video/mp4" } });
      fs.createReadStream(processedFile)
        .pipe(blobStream)
        .on("error", (err) => console.log("Error uploading video:", err))
        .on("finish", () => console.log(`Video from ${folderPath} uploaded successfully`));
    })
    .on("error", function (err) {
      console.log("Error processing video with ffmpeg:", err.message);
    })
    .run();
}

// API để xử lý khi bấm nút từ phía client
app.get("/extractVideo", (req, res) => {
  if (!isEmergency) {
    extractVideo(); // Chỉ thực hiện nếu không có yêu cầu khẩn cấp khác
  }
  res.json({ message: "Video extraction initiated" });
});

// Sử dụng cron để upload video mỗi phút
cron.schedule("*/2 * * * *", () => {
  console.log("Checking for video upload...");
  handleUploadAndDeletion();
});

// Sử dụng cron để xóa video cũ nhất mỗi 10 phút
cron.schedule("*/10 * * * *", () => {
  console.log("Deleting oldest video...");
  deleteOldestVideo();
});

// Function to delete the oldest video
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

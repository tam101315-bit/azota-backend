# 📚 Online Exam Management Platform

## 📌 Introduction
**Online Exam Management Platform** là một hệ thống web hỗ trợ giáo viên và tổ chức giáo dục trong việc:

- 📝 Tạo và quản lý đề thi  
- 📊 Theo dõi kết quả và hiệu suất học tập của học sinh  
- 🎯 Cung cấp báo cáo và thống kê trực quan  
- 💬 Tương tác và thông báo thời gian thực  

Mục tiêu dự án là mang lại một nền tảng **hiện đại**, **bảo mật**, và **thân thiện với người dùng**.

---

## 🛠 Technology Stack

### 🖥 Backend
- **Framework:** NestJS  
- **ORM:** TypeORM  

### 🎨 Frontend
- **Framework:** Nextjs + TypeScript  
- **UI:** Tailwind CSS  

### 🗄 Database
- **Relational DB:** MySQL  
- **NoSQL DB:** MongoDB Atlas  

### ⚡ Caching
- **Caching Layer:** Redis  

### 📂 Storage
- **File & Media Storage:** Firebase Storage  

### 🔔 Real-time
- **WebSocket:** Socket.IO  

### 🔑 Authentication
- **Method:** JWT  

### 🐳 Deployment
- **Containerization:** Docker  

---

## 🔥 Key Features

### 🔑 User Authentication
- ✅ Đăng ký và đăng nhập bảo mật cao với JWT  
- ✅ Hỗ trợ khôi phục mật khẩu  

### 📝 Exam & Question Management
- ✅ Tạo, chỉnh sửa, xóa bài thi và ngân hàng câu hỏi  
- ✅ Quản lý nội dung học tập, tài liệu, đề cương  

### 📊 Statistics & Reports
- ✅ Thống kê kết quả thi theo từng học sinh, lớp, hoặc kỳ thi  
- ✅ Biểu đồ phân tích hiệu suất học tập  

### 📢 Real-time Communication
- ✅ Thông báo thời gian thực qua WebSocket  
- ✅ Cập nhật trạng thái thi, kết quả, và tin nhắn nhanh chóng  

### 📂 Content Storage
- ✅ Lưu trữ tài liệu và hình ảnh trên Firebase Storage  
- ✅ Quản lý tài nguyên tập trung  

---

## 🏗 Architecture
Dự án được tách thành **Front-end** và **Back-end** riêng biệt.

**🎨 Front-end**  
- Nextjs + TypeScript  
- Tailwind CSS  

**⚙️ Back-end**  
- NestJS  
- TypeORM + MySQL  
- Redis  
- MongoDB Atlas  
- Firebase Storage  
- WebSocket (Socket.IO)  
- JWT  
- Docker  

---

## 🚀 Installation Guide

### 📌 Requirements
- Node.js (>= 14)  
- NPM hoặc Yarn  
- MySQL, Redis, Docker (nếu chạy container)  

### 📥 Steps
```bash
# Clone repository
git clone https://github.com/your_username/online-exam-platform.git

# Di chuyển vào thư mục dự án
cd online-exam-platform

# Cài dependencies
npm install
# hoặc
yarn install

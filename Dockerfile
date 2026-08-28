FROM node:20

WORKDIR /app

# Cài bộ công cụ nhẹ để đọc công thức hoá học nhúng dạng ảnh WMF trong file .docx đề thi:
# - libwmf-bin: convert .wmf -> .svg (wmf2svg)
# - librsvg2-bin: convert .svg -> .png (rsvg-convert)
# - ghostscript: cần cho một số thao tác xử lý ảnh liên quan (im/eps)
# Tổng dung lượng thêm vào chỉ khoảng 50-100MB, phù hợp với Render free tier (không dùng LibreOffice)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwmf-bin \
    librsvg2-bin \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["sh", "-c", "npm run start:prod"]

FROM node:20

WORKDIR /app

# Cài libwmf-bin (cung cấp lệnh wmf2gd) để đọc công thức hoá học/toán nhúng dạng ảnh WMF
# trong file .docx đề thi — render thẳng WMF -> PNG, không qua bước SVG/XML trung gian
# (tránh lỗi encoding UTF-8 hay gặp với một số font/ký tự đặc biệt trong công thức).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwmf-bin \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["sh", "-c", "npm run start:prod"]

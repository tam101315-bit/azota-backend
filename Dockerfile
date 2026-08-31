FROM node:20

WORKDIR /app

# Cài libwmf-bin (cung cấp lệnh wmf2gd) để đọc công thức hoá học/toán nhúng dạng ảnh WMF
# trong file .docx đề thi — render thẳng WMF -> PNG.
# QUAN TRỌNG: wmf2gd cần có ít nhất 1 bộ font cài trên hệ thống để vẽ được chữ trong công thức
# (nếu không sẽ lỗi "wmf_ipa_font_map: failed to load *any* font!") — image node:20 gốc không có
# sẵn font nào, nên bắt buộc phải cài thêm fonts-urw-base35 (~15MB, bộ font Type1 chuẩn) + fontconfig.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwmf-bin \
    fonts-urw-base35 \
    fontconfig \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["sh", "-c", "npm run start:prod"]

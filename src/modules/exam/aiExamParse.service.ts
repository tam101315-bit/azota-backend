import { Injectable, BadRequestException, InternalServerErrorException } from "@nestjs/common";

export interface AiParsedStatement {
  label: "a" | "b" | "c" | "d";
  text: string;
  isTrue: boolean;
}

export interface AiParsedQuestion {
  type: "MC" | "TF" | "SA";
  content: string;
  answers?: { A: string; B: string; C: string; D: string };
  correct?: "A" | "B" | "C" | "D";
  statements?: AiParsedStatement[];
  answer?: string;
}

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free";

const PROMPT = `Bạn đang xem các trang của một đề thi tiếng Việt (dạng ảnh chụp từng trang, theo đúng thứ tự trang).

Hãy đọc và tách TOÀN BỘ câu hỏi trong các trang này thành một mảng JSON duy nhất, theo đúng schema sau. CHỈ trả về JSON hợp lệ, không có chữ giải thích nào khác, không có markdown code fence (không bọc trong \`\`\`):

{
  "questions": [
    {
      "type": "MC",
      "content": "nội dung câu hỏi",
      "answers": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "correct": "A"
    },
    {
      "type": "TF",
      "content": "nội dung câu hỏi chính",
      "statements": [
        { "label": "a", "text": "...", "isTrue": true },
        { "label": "b", "text": "...", "isTrue": false },
        { "label": "c", "text": "...", "isTrue": true },
        { "label": "d", "text": "...", "isTrue": false }
      ]
    },
    {
      "type": "SA",
      "content": "nội dung câu hỏi",
      "answer": "đáp án đúng nếu tài liệu có ghi sẵn, nếu không có thì để chuỗi rỗng \"\""
    }
  ]
}

Lưu ý quan trọng:
Quy tắc phân loại loại câu hỏi (RẤT QUAN TRỌNG — đọc kỹ trước khi quyết định type):
- "MC" (Trắc nghiệm): CHỈ dùng khi câu hỏi có liệt kê sẵn các phương án trả lời (ví dụ A/B/C/D hoặc 1/2/3/4).
- "TF" (Đúng/Sai): CHỈ dùng khi câu hỏi có đúng 4 mệnh đề nhỏ dạng a) b) c) d) mà người làm phải đánh giá đúng/sai từng ý.
- "SA" (Trả lời ngắn): dùng cho MỌI câu hỏi KHÔNG có phương án trả lời nào được liệt kê sẵn trong đề — ví dụ câu yêu cầu tính toán, điền số, điền từ, viết công thức. Đây là trường hợp RẤT PHỔ BIẾN, đừng nhầm sang "MC". Tuyệt đối không tự bịa ra 4 phương án A/B/C/D nếu đề gốc không hề ghi chúng.
- Giữ đúng thứ tự câu hỏi xuất hiện trong tài liệu, gộp chung tất cả các trang thành 1 mảng "questions" duy nhất.
- Với câu Trắc nghiệm: đáp án đúng thường được đánh dấu bằng màu chữ khác biệt (ví dụ đỏ, hoặc in đậm) so với các đáp án còn lại — hãy nhìn kỹ và suy luận đáp án đúng dựa vào dấu hiệu này. Nếu không có dấu hiệu rõ ràng, để "correct": "A" làm mặc định.
- Với câu Đúng/Sai: nếu tài liệu không cho biết ý nào đúng/sai, để tất cả "isTrue": false — người dùng sẽ tự chọn lại.
- Bỏ qua watermark, logo, số trang, tên đơn vị phát hành tài liệu — chỉ lấy nội dung đề thi thật.`;

function stripJsonFence(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

@Injectable()
export class AiExamParseService {
  async parseFromImages(images: string[]): Promise<{ questions: AiParsedQuestion[] }> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException("OPENROUTER_API_KEY chưa được cấu hình trên server.");
    }
    if (!images || images.length === 0) {
      throw new BadRequestException("Không có ảnh nào được gửi lên.");
    }

    const content: any[] = [{ type: "text", text: PROMPT }];
    images.forEach((base64) => {
      const dataUrl = base64.startsWith("data:") ? base64 : `data:image/jpeg;base64,${base64}`;
      content.push({ type: "image_url", image_url: { url: dataUrl } });
    });

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
  models: [
    OPENROUTER_MODEL,
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ],
  messages: [{ role: "user", content }],
}),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new InternalServerErrorException(`OpenRouter API lỗi (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const rawText: string | undefined = data?.choices?.[0]?.message?.content;

    if (!rawText) {
      throw new InternalServerErrorException("OpenRouter không trả về nội dung hợp lệ.");
    }

    try {
      const parsed = JSON.parse(stripJsonFence(rawText));
      if (!Array.isArray(parsed?.questions)) {
        throw new Error("missing questions array");
      }
      return parsed;
    } catch (err) {
      throw new InternalServerErrorException(
        "Không đọc được JSON từ phản hồi của OpenRouter: " + rawText.slice(0, 300),
      );
    }
  }
}

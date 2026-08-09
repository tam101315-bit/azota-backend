import { Injectable, BadRequestException, InternalServerErrorException } from "@nestjs/common";

interface AiParsedStatement {
  label: "a" | "b" | "c" | "d";
  text: string;
  isTrue: boolean;
}

interface AiParsedQuestion {
  type: "MC" | "TF" | "SA";
  content: string;
  answers?: { A: string; B: string; C: string; D: string };
  correct?: "A" | "B" | "C" | "D";
  statements?: AiParsedStatement[];
  answer?: string;
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const PROMPT = `Bạn đang xem các trang của một đề thi tiếng Việt (dạng ảnh chụp từng trang, theo đúng thứ tự trang).

Hãy đọc và tách TOÀN BỘ câu hỏi trong các trang này thành một mảng JSON duy nhất, theo đúng schema sau (không thêm chữ giải thích nào khác ngoài JSON):

{
  "questions": [
    // Loại 1: Trắc nghiệm 4 đáp án (chỉ 1 đáp án đúng)
    {
      "type": "MC",
      "content": "nội dung câu hỏi",
      "answers": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "correct": "A"  // chữ cái đáp án đúng - suy luận từ màu chữ khác biệt, in đậm, hoặc dấu hiệu đánh dấu đáp án đúng trong ảnh
    },
    // Loại 2: Đúng/Sai (4 ý nhỏ a/b/c/d, mỗi ý đúng hoặc sai độc lập)
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
    // Loại 3: Trả lời ngắn (câu hỏi tự luận ngắn, không có lựa chọn)
    {
      "type": "SA",
      "content": "nội dung câu hỏi",
      "answer": "đáp án đúng nếu tài liệu có ghi sẵn, nếu không có thì để chuỗi rỗng \"\""
    }
  ]
}

Lưu ý quan trọng:
- Giữ đúng thứ tự câu hỏi xuất hiện trong tài liệu, gộp chung tất cả các trang thành 1 mảng "questions" duy nhất.
- Với câu Trắc nghiệm: nếu không có dấu hiệu rõ ràng nào cho đáp án đúng (không tô màu/in đậm khác biệt), hãy để "correct": "A" làm mặc định — người dùng sẽ tự kiểm tra lại.
- Với câu Đúng/Sai: nếu tài liệu không cho biết ý nào đúng/sai, hãy để tất cả "isTrue": false — người dùng sẽ tự chọn lại.
- Bỏ qua watermark, logo, số trang, tên đơn vị phát hành tài liệu — chỉ lấy nội dung đề thi thật.
- Chỉ trả về JSON hợp lệ, không có markdown code fence, không có chữ nào khác.`;

@Injectable()
export class AiExamParseService {
  async parseFromImages(images: string[]): Promise<{ questions: AiParsedQuestion[] }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException("GEMINI_API_KEY chưa được cấu hình trên server.");
    }
    if (!images || images.length === 0) {
      throw new BadRequestException("Không có ảnh nào được gửi lên.");
    }

    const parts: any[] = images.map((base64) => ({
      inline_data: {
        mime_type: "image/jpeg",
        data: base64.replace(/^data:image\/\w+;base64,/, ""),
      },
    }));
    parts.push({ text: PROMPT });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new InternalServerErrorException(`Gemini API lỗi (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      throw new InternalServerErrorException("Gemini không trả về nội dung hợp lệ.");
    }

    try {
      const parsed = JSON.parse(rawText);
      if (!Array.isArray(parsed?.questions)) {
        throw new Error("missing questions array");
      }
      return parsed;
    } catch (err) {
      throw new InternalServerErrorException("Không đọc được JSON từ phản hồi của Gemini: " + rawText.slice(0, 300));
    }
  }
}

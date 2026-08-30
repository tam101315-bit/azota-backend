import { SetMetadata } from "@nestjs/common";

export const LONG_RUNNING_KEY = "isLongRunning";

/**
 * Đánh dấu 1 route cần nhiều thời gian xử lý hơn mức timeout mặc định (60s)
 * của TimeoutInterceptor toàn cục — ví dụ route xử lý AI, convert file nặng...
 * TimeoutInterceptor sẽ đọc metadata này để áp dụng ngưỡng timeout dài hơn thay vì chặn ở 60s.
 */
export const LongRunning = () => SetMetadata(LONG_RUNNING_KEY, true);

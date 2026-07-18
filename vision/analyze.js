const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const MODEL = "gemini-3.5-flash";
const OUTPUT_SIZE = 1080; // 알로소 기본 소재 사이즈

// Windows NTFS는 파일명을 정규화하지 않고 그대로 저장하는데, 한글 파일명이 NFD(자모 분리형)로
// 저장된 경우 우리가 전달받은 NFC(완성형) 경로와 바이트 단위로 일치하지 않아 ENOENT가 난다.
// 정확히 못 찾으면 디렉터리를 읽어 NFC 기준으로 재매칭한다.
function resolveActualPath(filePath) {
  if (fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const wanted = path.basename(filePath).normalize("NFC");
  const entries = fs.readdirSync(dir);
  const match = entries.find((e) => e.normalize("NFC") === wanted);
  if (!match) {
    throw new Error(`파일을 찾을 수 없음: ${filePath}`);
  }
  return path.join(dir, match);
}

// 모델에게 두 장의 이미지를 함께 준다:
//   referenceImage(시안) - 광고주가 준 레이아웃/구도 레퍼런스 (텍스트/로고 포함된 완성본)
//   originalImage(원본)  - 크롭되지 않은 실제 고해상도 원본 사진
// 모델은 원본 이미지 좌표계에서 "시안과 같은 구도를 재현하는 정사각형 크롭 영역"을 찾고,
// 텍스트/로고 위치는 1080x1080 출력 캔버스 기준으로 스케일링해서 알려준다.
const MATERIAL_SPEC_SCHEMA = {
  type: "object",
  properties: {
    cropRect: {
      type: "object",
      description:
        "원본 이미지 좌표계에서, 시안과 동일한 구도를 재현하기 위해 잘라내야 할 정사각형 영역(x, y, width, height). width와 height는 같아야 함(정사각형)",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["x", "y", "width", "height"],
    },
    texts: {
      type: "array",
      description: `모든 좌표는 최종 출력 캔버스(${OUTPUT_SIZE}x${OUTPUT_SIZE}px) 기준으로 스케일링해서 산출`,
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          x: { type: "integer" },
          y: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
          fontSize: { type: "integer" },
          fontWeight: { type: "string", enum: ["regular", "medium", "bold"] },
          color: {
            type: "array",
            items: { type: "number" },
            minItems: 3,
            maxItems: 3,
            description: "텍스트 색상. 반드시 0~1 사이의 실수로 표현한 RGB (예: 흰색은 [1, 1, 1], 0~255 정수 아님)",
          },
          align: { type: "string", enum: ["LEFT", "CENTER", "RIGHT"] },
          backdrop: {
            type: "object",
            description:
              "텍스트 가독성이 배경 이미지 때문에 떨어질 것으로 판단되면 뒤에 깔 패널. 필요 없으면 생략",
            properties: {
              type: { type: "string", enum: ["gradient", "blur"] },
              color: {
                type: "array",
                items: { type: "number" },
                minItems: 4,
                maxItems: 4,
                description: "배경 이미지의 어두운 영역에서 추출한 RGBA 0-1 값",
              },
              blurRadius: { type: "number", description: "blur 타입일 때만 사용, 기본 20" },
            },
            required: ["type", "color"],
          },
          highlights: {
            type: "array",
            description:
              "content 안에서 일부 단어만 다른 색으로 강조해야 하면 그 단어와 색을 기재. 'LIVE'는 렌더링 단계에서 항상 로고 이미지로 자동 치환되므로 여기 포함하지 말 것. 강조할 부분이 없으면 생략",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "content 안에 정확히 포함된 부분 문자열" },
                color: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 3,
                  maxItems: 3,
                  description: "0~1 사이 실수 RGB",
                },
              },
              required: ["text", "color"],
            },
          },
        },
        required: ["content", "x", "y", "width", "height", "fontSize", "fontWeight", "color"],
      },
    },
    logoPlacement: {
      type: "object",
      description: `브랜드 로고가 배치되어야 할 위치와 크기. ${OUTPUT_SIZE}x${OUTPUT_SIZE} 출력 캔버스 기준 픽셀 좌표`,
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["x", "y", "width", "height"],
    },
    liveBadgePlacement: {
      type: "object",
      description: `LIVE 뱃지(빨간 사각형 + LIVE 텍스트)가 시안에 보이면, 그 위치와 크기. ${OUTPUT_SIZE}x${OUTPUT_SIZE} 출력 캔버스 기준 픽셀 좌표. 안 보이면 생략`,
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["x", "y", "width", "height"],
    },
  },
  required: ["cropRect", "texts"],
};

const PRODUCTION_RULES = `
알로소(Alloso) 소재 제작 규칙:

[기본 사이즈]
- 모든 소재의 기본 출력 사이즈는 ${OUTPUT_SIZE}x${OUTPUT_SIZE}px (정사각형)

[폰트]
- 국문은 Pretendard, 영문/숫자는 Century Gothic으로 자동 분기되므로 fontWeight만 판단하면 됨(폰트 패밀리는 렌더링 단계에서 문자 단위로 자동 처리)
- 메인 타이틀은 bold, 서브 텍스트는 regular로 판단. 얇은(regular) 텍스트는 시안에서도 가늘고 심플한 인상이어야 함

[텍스트]
- 메인 타이틀 fontSize는 68px 이내 권장(고정값 아님, 시안 비율 보고 판단)
- 서브타이틀 fontSize는 메인 타이틀의 약 60%
- align은 시안에 보이는 정렬(좌/중앙/우)을 그대로 따를 것
- 문장 중간에 "LIVE" 단어가 보이면 content에 "LIVE"라는 글자를 그대로 포함해서 적을 것 (렌더링 시 자동으로 로고 이미지로 치환됨, highlights로 색만 바꾸지 말 것)
- "LIVE" 외에 특정 단어만 다른 색으로 강조되어 있으면 그 단어와 색을 highlights에 기재

[이미지 크롭]
- 시안 이미지는 이미 완성된 레이아웃 레퍼런스이고, 원본 이미지는 크롭되지 않은 고해상도 사진이다
- 원본 이미지에서, 시안과 동일한 구도(제품이 보이는 각도/비율/여백)를 재현하는 정사각형 영역을 cropRect로 산출할 것
- 원본 이미지가 시안보다 훨씬 넓은 화각을 담고 있을 수 있으므로, 시안 속 피사체(소파/의자 등)와 동일한 피사체를 원본에서 찾아 정렬 기준으로 삼을 것

[로고]
- 로고는 별도 PNG 파일을 그대로 사용하므로, logoPlacement에는 로고가 들어갈 위치/크기만 기재한다 (로고 이미지 자체를 만들거나 크롭하지 않음)

[LIVE 뱃지]
- 빨간 사각형 배경에 흰색 "LIVE" 글자가 있는 뱃지는 별도 SVG 파일을 그대로 사용하므로, liveBadgePlacement에는 위치/크기만 기재한다 (텍스트나 배경을 직접 만들지 않음)
- 시안에 LIVE 뱃지가 없으면 liveBadgePlacement는 생략

[가독성 처리 - backdrop]
- 텍스트가 배경 이미지 위에 있어 가독성이 떨어질 것으로 보이면 backdrop 필드를 채울 것
- 배경 이미지가 어둡거나 복잡한 영역 위의 텍스트: type "gradient" (텍스트 아래쪽에 옅게 깔리는 그라데이션 패널) 또는 "blur" (블러 처리된 패널) 중 시안에 더 가까운 방식으로 판단
- backdrop.color는 반드시 그 텍스트 주변 배경 이미지의 어두운 영역 색상에서 추출한 값을 사용 (임의의 검정색 사용 금지)
- 텍스트가 이미 단색/그라데이션 배경 위에 있어 가독성 문제가 없으면 backdrop 생략

[톤앤무드]
- 깔끔하고 절제된 톤, 텍스트+이미지 위주 구성, 그리드형 정렬 선호, 과한 장식 지양 — 이 톤에서 벗어나는 과도한 크기/색상 판단은 피할 것
`;

function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function loadImagePart(filePath) {
  const resolvedPath = resolveActualPath(filePath);
  const buffer = fs.readFileSync(resolvedPath);
  const metadata = await sharp(buffer).metadata();
  return {
    buffer,
    width: metadata.width,
    height: metadata.height,
    mimeType: detectMimeType(resolvedPath),
    base64: buffer.toString("base64"),
  };
}

async function analyze(originalPath, referencePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  const original = await loadImagePart(originalPath);
  const reference = await loadImagePart(referencePath);

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      `[시안 이미지] 광고주가 준 레이아웃 레퍼런스입니다. 실제 크기는 ${reference.width}x${reference.height}px 입니다.`,
      { inlineData: { mimeType: reference.mimeType, data: reference.base64 } },
      `[원본 이미지] 크롭되지 않은 고해상도 원본 사진입니다. 실제 크기는 ${original.width}x${original.height}px 입니다.`,
      { inlineData: { mimeType: original.mimeType, data: original.base64 } },
      `위 두 이미지를 비교해서 아래 스키마에 맞는 JSON을 추출하세요.
${PRODUCTION_RULES}`,
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: MATERIAL_SPEC_SCHEMA,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });

  const finishReason = response.candidates && response.candidates[0] && response.candidates[0].finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.error(`경고: 응답이 정상 종료되지 않음 (finishReason: ${finishReason})`);
  }

  let spec;
  try {
    spec = JSON.parse(response.text);
  } catch (parseErr) {
    const debugPath = path.join(__dirname, "debug-raw-response.txt");
    fs.writeFileSync(debugPath, response.text || "(response.text가 비어있음)", "utf-8");
    throw new Error(
      `모델 응답을 JSON으로 파싱하지 못함 (finishReason: ${finishReason}). 원본 응답을 ${debugPath}에 저장했습니다. 원인: ${parseErr.message}`,
    );
  }

  normalizeSpecColors(spec);
  return { spec, original };
}

// 모델이 가끔 0~1 대신 0~255 스케일로 색상을 반환하는 경우를 방어적으로 보정한다.
function normalizeColor(arr) {
  if (!Array.isArray(arr)) return arr;
  const needsScaling = arr.some((v) => v > 1);
  return needsScaling ? arr.map((v) => v / 255) : arr;
}

function normalizeSpecColors(spec) {
  for (const t of spec.texts || []) {
    if (t.color) t.color = normalizeColor(t.color);
    if (t.backdrop && t.backdrop.color) t.backdrop.color = normalizeColor(t.backdrop.color);
  }
}

function clampCropRect(rect, imageWidth, imageHeight) {
  const size = Math.max(1, Math.min(rect.width, rect.height, imageWidth, imageHeight));
  const x = Math.max(0, Math.min(rect.x, imageWidth - size));
  const y = Math.max(0, Math.min(rect.y, imageHeight - size));
  return { x, y, size };
}

async function cropAndResizeOriginal(original, cropRect) {
  const { x, y, size } = clampCropRect(cropRect, original.width, original.height);
  const buffer = await sharp(original.buffer)
    .extract({ left: x, top: y, width: size, height: size })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover" })
    .png()
    .toBuffer();
  return buffer.toString("base64");
}

async function buildMaterialSpec(originalPath, referencePath, logoPath, liveBadgePath, frameName) {
  const { spec, original } = await analyze(originalPath, referencePath);

  const croppedBase64 = await cropAndResizeOriginal(original, spec.cropRect);

  const result = {
    frame: { name: frameName || path.basename(originalPath), width: OUTPUT_SIZE, height: OUTPUT_SIZE },
    mainImage: { x: 0, y: 0, width: OUTPUT_SIZE, height: OUTPUT_SIZE, base64: croppedBase64 },
    texts: spec.texts,
  };

  if (spec.logoPlacement && logoPath) {
    const logoBase64 = fs.readFileSync(resolveActualPath(logoPath)).toString("base64");
    result.logo = { ...spec.logoPlacement, base64: logoBase64 };
  } else if (spec.logoPlacement) {
    result.logo = { ...spec.logoPlacement };
  }

  if (spec.liveBadgePlacement && liveBadgePath) {
    const liveBadgeBase64 = fs.readFileSync(resolveActualPath(liveBadgePath)).toString("base64");
    result.liveBadge = { ...spec.liveBadgePlacement, base64: liveBadgeBase64 };
  } else if (spec.liveBadgePlacement) {
    result.liveBadge = { ...spec.liveBadgePlacement };
  }

  return result;
}

async function main() {
  let originalPath, referencePath, logoPath, liveBadgePath, outPathArg;

  // Windows 콘솔에서 한글 경로를 커맨드라인 인자로 넘기면 인코딩이 깨지는 경우가 있어,
  // --args-file <json경로> 로 UTF-8 JSON 파일을 통해 경로를 전달하는 방식도 지원한다.
  if (process.argv[2] === "--args-file") {
    const argsFilePath = process.argv[3];
    const parsed = JSON.parse(fs.readFileSync(argsFilePath, "utf-8"));
    originalPath = parsed.originalPath;
    referencePath = parsed.referencePath;
    logoPath = parsed.logoPath;
    liveBadgePath = parsed.liveBadgePath;
    outPathArg = parsed.outPath;
  } else {
    [originalPath, referencePath, logoPath, liveBadgePath, outPathArg] = process.argv.slice(2);
  }

  if (!originalPath || !referencePath) {
    console.error(
      "사용법: node vision/analyze.js <원본이미지경로> <시안이미지경로> [로고PNG경로] [LIVE뱃지SVG경로] [출력경로]\n" +
        "     또는: node vision/analyze.js --args-file <json경로>",
    );
    process.exitCode = 1;
    return;
  }
  const outPath = outPathArg || path.join(__dirname, "output-spec.json");

  const spec = await buildMaterialSpec(originalPath, referencePath, logoPath, liveBadgePath);
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2), "utf-8");
  console.log(`스펙 생성 완료: ${outPath}`);
}

main().catch((err) => {
  console.error("분석 실패:", err.message);
  process.exitCode = 1;
});

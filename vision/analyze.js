const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { OUTPUT_SIZE, getProductionRules } = require("./rules");

const MODEL = "gemini-3.5-flash";

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
                description: "배경의 어두운 영역 색상 또는 텍스트 색과 대비되는 색의 RGBA 0-1 값 (마지막 값은 blur 타입일 때만 쓰이는 opacity, gradient 타입이고 stops를 지정하면 무시됨)",
              },
              blurRadius: { type: "number", description: "blur 타입일 때만 사용, 기본 20" },
              angle: {
                type: "integer",
                description:
                  "gradient 타입 전용. 그라데이션 진행 방향(도, 0~360). 시안에 보이는 각도를 그대로 판단할 것 (수직이면 90 또는 270, 대각이면 그 사이 각도, 예: 27). 생략하면 기본값 270(아래쪽이 진하고 위로 갈수록 옅어지는 수직 방향)",
              },
              stops: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                description:
                  "gradient 타입 전용. 정지점 2개[시작, 끝]. 시안처럼 일정 구간까지는 solid로 유지되다가 그 다음 페이드되는 경우 이걸로 표현 (예: 45%까지 solid, 92%까지 투명으로 페이드 → [{position:0.45, alpha:1}, {position:0.92, alpha:0}]). 생략하면 기본값([{position:0,alpha:0},{position:1,alpha:1}], 즉 처음부터 끝까지 균일하게 페이드)",
                items: {
                  type: "object",
                  properties: {
                    position: { type: "number", description: "0~1" },
                    alpha: { type: "number", description: "0~1" },
                  },
                  required: ["position", "alpha"],
                },
              },
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
    badgePlacement: {
      type: "object",
      description: `캡슐형(알약 모양, 완전히 둥근 모서리) 프로모션 뱃지(예: 할인율/이벤트명이 검정 배경+흰 텍스트로 들어간 뱃지)가 시안에 보이면, 그 위치와 크기. 별도 PNG 파일을 그대로 사용하므로 위치/크기만 산출. ${OUTPUT_SIZE}x${OUTPUT_SIZE} 출력 캔버스 기준 픽셀 좌표. 안 보이면 생략`,
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

function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function loadImagePart(filePath) {
  const resolvedPath = resolveActualPath(filePath);
  const rawBuffer = fs.readFileSync(resolvedPath);
  // 휴대폰으로 찍은 원본 사진은 EXIF orientation 태그로 회전 방향만 표시하고 픽셀 자체는 눕혀서
  // 저장된 경우가 많다. sharp는 이 태그를 무시하고 원본 픽셀 그대로 다루는 반면, Gemini에 보낸
  // 이미지는 (뷰어처럼) EXIF를 반영해 세운 방향으로 인식해서 cropRect를 돌려주기 때문에, 나중에
  // 같은 좌표로 원본 픽셀을 크롭하면 방향이 어긋난다. rotate()로 EXIF 방향을 픽셀에 반영하고
  // 태그를 제거한 버퍼로 통일해서, 모델이 보는 방향과 크롭에 쓰는 픽셀 방향을 일치시킨다.
  const buffer = await sharp(rawBuffer).rotate().toBuffer();
  const metadata = await sharp(buffer).metadata();
  return {
    buffer,
    width: metadata.width,
    height: metadata.height,
    mimeType: detectMimeType(resolvedPath),
    base64: buffer.toString("base64"),
  };
}

async function analyze(originalPath, referencePath, category) {
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
${getProductionRules(category)}`,
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

// 두 사각형(x,y,width,height)이 겹치는지 확인. 모델이 같은 LIVE 요소를 인라인 텍스트와 별도
// liveBadgePlacement로 중복 반환했는지 판단하는 데 쓴다(겹치면 중복, 안 겹치면 서로 다른 인스턴스).
function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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

async function buildMaterialSpec(originalPath, referencePath, logoPath, liveBadgePath, frameName, category, badgePath) {
  const { spec, original } = await analyze(originalPath, referencePath, category);

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

  // 문장 속 인라인 "LIVE"(texts 안의 글자)와 날짜 옆 별도 liveBadgePlacement는 한 소재 안에 동시에
  // 나올 수 있는 서로 다른 두 인스턴스다(예: 날짜 옆 독립 배지 + 본문 카피 속 LIVE). 모든 "LIVE" 글자는
  // 항상 로고 이미지로 치환되어야 하므로 원칙적으로 둘 다 붙인다 — 다만 모델이 같은 LIVE를 중복으로
  // 반환하는 경우(별도 배지 위치가 인라인 LIVE가 있는 텍스트 영역과 겹침)만 배지 쪽을 무시한다.
  const inlineLiveTexts = (spec.texts || []).filter((t) => t.content && t.content.includes("LIVE"));
  const hasInlineLive = inlineLiveTexts.length > 0;
  const liveBadgeIsDuplicate =
    spec.liveBadgePlacement && inlineLiveTexts.some((t) => rectsOverlap(spec.liveBadgePlacement, t));

  if ((spec.liveBadgePlacement && !liveBadgeIsDuplicate) || hasInlineLive) {
    const liveBadgeBase64 = liveBadgePath ? fs.readFileSync(resolveActualPath(liveBadgePath)).toString("base64") : undefined;
    if (spec.liveBadgePlacement && !liveBadgeIsDuplicate) {
      result.liveBadge = liveBadgeBase64
        ? { ...spec.liveBadgePlacement, base64: liveBadgeBase64 }
        : { ...spec.liveBadgePlacement };
    }
    if (hasInlineLive && liveBadgeBase64) {
      result.liveLogoAsset = { base64: liveBadgeBase64 };
    }
  }

  if (spec.badgePlacement && badgePath) {
    const badgeBase64 = fs.readFileSync(resolveActualPath(badgePath)).toString("base64");
    result.badge = { ...spec.badgePlacement, base64: badgeBase64 };
  } else if (spec.badgePlacement) {
    result.badge = { ...spec.badgePlacement };
  }

  return result;
}

async function runSingle({ originalPath, referencePath, logoPath, liveBadgePath, outPath, category, badgePath }) {
  const resolvedOutPath = outPath || path.join(__dirname, "output-spec.json");
  const spec = await buildMaterialSpec(originalPath, referencePath, logoPath, liveBadgePath, undefined, category, badgePath);
  fs.writeFileSync(resolvedOutPath, JSON.stringify(spec, null, 2), "utf-8");
  console.log(`스펙 생성 완료: ${resolvedOutPath}`);
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function listImageFiles(dirPath) {
  return fs
    .readdirSync(dirPath)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(dirPath, name));
}

// 파일명에 포함된 마지막 숫자 그룹을 그 파일의 순번으로 사용한다.
// 예: "시안_02.png" -> 2, "3_원본.jpg" -> 3, "IMG_20240101_05.png" -> 5(마지막 그룹)
function extractNumber(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const matches = base.match(/\d+/g);
  if (!matches) return null;
  return parseInt(matches[matches.length - 1], 10);
}

// 폴더 안 이미지 파일들을 파일명 속 번호로 매핑한다. 번호가 없거나 같은 번호가 중복되면 에러로 알려준다.
function buildNumberMap(filePaths, label) {
  const map = new Map();
  const noNumber = [];
  for (const filePath of filePaths) {
    const num = extractNumber(filePath);
    if (num === null) {
      noNumber.push(filePath);
      continue;
    }
    if (map.has(num)) {
      throw new Error(
        `${label}에서 번호(${num})가 중복됩니다: "${path.basename(map.get(num))}" 와 "${path.basename(filePath)}". ` +
          `파일명에 서로 다른 번호를 부여해주세요.`,
      );
    }
    map.set(num, filePath);
  }
  if (noNumber.length > 0) {
    throw new Error(
      `${label}에서 파일명에 번호가 없어 원본-시안을 매칭할 수 없습니다: ${noNumber.map((p) => path.basename(p)).join(", ")}\n` +
        `파일명에 순번(예: "시안_1.png", "원본_1.jpg")을 포함해서 짝지어주세요.`,
    );
  }
  return map;
}

// 원본이미지 폴더와 시안 폴더를 파일명 번호로 짝지어서, 매칭된 쌍마다 순서대로 analyze.js를 실행한다.
// Gemini API 레이트리밋(429) 이력이 있어 병렬이 아니라 순차 실행한다.
async function runBatch({ originalsDir, referencesDir, logoPath, liveBadgePath, badgePath, category, outDir }) {
  const originalMap = buildNumberMap(listImageFiles(originalsDir), "원본이미지 폴더");
  const referenceMap = buildNumberMap(listImageFiles(referencesDir), "시안 폴더");

  const originalNumbers = new Set(originalMap.keys());
  const referenceNumbers = new Set(referenceMap.keys());
  const matchedNumbers = [...referenceNumbers].filter((n) => originalNumbers.has(n)).sort((a, b) => a - b);
  const unmatchedReferences = [...referenceNumbers].filter((n) => !originalNumbers.has(n)).sort((a, b) => a - b);
  const unmatchedOriginals = [...originalNumbers].filter((n) => !referenceNumbers.has(n)).sort((a, b) => a - b);

  if (unmatchedReferences.length > 0) {
    console.error(`경고: 매칭되는 원본이 없어 건너뛴 시안 번호: ${unmatchedReferences.join(", ")}`);
  }
  if (unmatchedOriginals.length > 0) {
    console.error(`경고: 매칭되는 시안이 없어 건너뛴 원본 번호: ${unmatchedOriginals.join(", ")}`);
  }
  if (matchedNumbers.length === 0) {
    throw new Error("매칭되는 원본/시안 쌍이 없습니다.");
  }

  fs.mkdirSync(outDir, { recursive: true });

  const succeeded = [];
  const failed = [];
  for (let i = 0; i < matchedNumbers.length; i++) {
    const num = matchedNumbers[i];
    const originalPath = originalMap.get(num);
    const referencePath = referenceMap.get(num);
    console.log(
      `[${i + 1}/${matchedNumbers.length}] 번호 ${num} 처리 중... ` +
        `(원본: ${path.basename(originalPath)}, 시안: ${path.basename(referencePath)})`,
    );
    try {
      const spec = await buildMaterialSpec(
        originalPath,
        referencePath,
        logoPath,
        liveBadgePath,
        `${num}. ${path.basename(originalPath, path.extname(originalPath))}`,
        category,
        badgePath,
      );
      const outPath = path.join(outDir, `output-spec-${num}.json`);
      fs.writeFileSync(outPath, JSON.stringify(spec, null, 2), "utf-8");
      succeeded.push({ num, outPath });
      console.log(`  -> 완료: ${outPath}`);
    } catch (err) {
      failed.push({ num, message: err.message });
      console.error(`  -> 실패 (번호 ${num}): ${err.message}`);
    }
  }

  console.log(`\n배치 완료: 성공 ${succeeded.length}건, 실패 ${failed.length}건`);
  if (failed.length > 0) {
    console.log(`실패한 번호: ${failed.map((f) => f.num).join(", ")} (위 로그에서 원인 확인)`);
  }
}

async function main() {
  // Windows 콘솔에서 한글 경로를 커맨드라인 인자로 넘기면 인코딩이 깨지는 경우가 있어,
  // --args-file <json경로> 로 UTF-8 JSON 파일을 통해 경로를 전달하는 방식도 지원한다.
  if (process.argv[2] === "--args-file") {
    const argsFilePath = process.argv[3];
    // PowerShell Out-File/Set-Content -Encoding utf8은 기본적으로 BOM을 붙이는데, 그대로 두면
    // JSON.parse가 선두의 BOM 문자를 토큰 에러로 처리하므로 제거하고 파싱한다.
    const argsFileText = fs.readFileSync(argsFilePath, "utf-8").replace(/^﻿/, "");
    const parsed = JSON.parse(argsFileText);

    // originalsDir/referencesDir이 있으면 배치 모드로 판단, 없으면 기존 단일 모드로 처리
    if (parsed.originalsDir && parsed.referencesDir) {
      const outDir = parsed.outDir || path.join(__dirname, "output");
      await runBatch({ ...parsed, outDir });
      return;
    }

    if (!parsed.originalPath || !parsed.referencePath) {
      console.error('args-file JSON에 originalPath/referencePath (단일 모드) 또는 originalsDir/referencesDir (배치 모드)가 필요합니다.');
      process.exitCode = 1;
      return;
    }
    await runSingle({
      originalPath: parsed.originalPath,
      referencePath: parsed.referencePath,
      logoPath: parsed.logoPath,
      liveBadgePath: parsed.liveBadgePath,
      outPath: parsed.outPath,
      category: parsed.category,
      badgePath: parsed.badgePath,
    });
    return;
  }

  if (process.argv[2] === "--batch") {
    const [originalsDir, referencesDir, logoPath, liveBadgePath, outDirArg, category, badgePath] = process.argv.slice(3);
    if (!originalsDir || !referencesDir) {
      console.error(
        "사용법: node vision/analyze.js --batch <원본이미지폴더> <시안폴더> [로고PNG경로] [LIVE뱃지PNG경로] [출력폴더] [카테고리] [프로모션뱃지PNG경로]\n" +
          "     또는: node vision/analyze.js --args-file <json경로> (JSON에 originalsDir/referencesDir 지정)\n" +
          "원본/시안 폴더 안 파일명에 같은 번호가 들어간 파일끼리 자동으로 짝지어 각각 처리합니다 (예: 원본_1.jpg <-> 시안_1.png)",
      );
      process.exitCode = 1;
      return;
    }
    const outDir = outDirArg || path.join(__dirname, "output");
    await runBatch({ originalsDir, referencesDir, logoPath, liveBadgePath, badgePath, category, outDir });
    return;
  }

  const [originalPath, referencePath, logoPath, liveBadgePath, outPathArg, category, badgePath] = process.argv.slice(2);

  if (!originalPath || !referencePath) {
    console.error(
      "사용법: node vision/analyze.js <원본이미지경로> <시안이미지경로> [로고PNG경로] [LIVE뱃지PNG경로] [출력경로] [카테고리] [프로모션뱃지PNG경로]\n" +
        "     또는: node vision/analyze.js --args-file <json경로>\n" +
        "     또는: node vision/analyze.js --batch <원본이미지폴더> <시안폴더> [로고PNG경로] [LIVE뱃지PNG경로] [출력폴더] [카테고리] [프로모션뱃지PNG경로]\n" +
        "카테고리(선택): 네이버기획전 | 29cm기획전 | 제품인지 | 별도기획전 (생략 시 공통 규칙만 적용)",
    );
    process.exitCode = 1;
    return;
  }
  await runSingle({ originalPath, referencePath, logoPath, liveBadgePath, outPath: outPathArg, category, badgePath });
}

main().catch((err) => {
  console.error("분석 실패:", err.message);
  process.exitCode = 1;
});

// brand.config.json의 값을 code.ts의 BRAND_CONFIG_START~END 마커 사이 상수 블록에 그대로 주입한다.
// Figma 플러그인은 번들러 없이 tsc로 code.ts 단일 파일만 컴파일하므로 런타임에 JSON을 읽을 수 없어,
// 빌드 직전에 이 스크립트가 값을 텍스트로 미리 박아넣는 방식을 쓴다. npm run build/watch가 tsc보다
// 먼저 이 스크립트를 실행한다.
//
// 마커 밖(렌더링 로직 전체)은 이 스크립트가 절대 건드리지 않는다 — 그 보장을 스크립트 자신이 실행 시마다
// 재검증한다(assertOutsideMarkersUnchanged). 마커가 없거나, 한쪽만 있거나, 중복되면 무엇을 바꿔야 할지
// 알 수 없으므로 조용히 넘어가지 않고 에러로 중단한다.

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const BRAND_CONFIG_PATH = path.join(ROOT_DIR, "brand.config.json");
const CODE_TS_PATH = path.join(ROOT_DIR, "code.ts");

const START_MARKER =
  "// === BRAND_CONFIG_START (자동 생성 — 직접 수정 금지, brand.config.json을 고치고 npm run build 실행) ===";
const END_MARKER = "// === BRAND_CONFIG_END ===";

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function generateBlock(brandConfig) {
  const { font, liveInlineLogo, backdrop, highlightBadge } = brandConfig;
  return [
    `const KR_FAMILY = ${JSON.stringify(font.krFamily)};`,
    `const LATIN_FAMILY = ${JSON.stringify(font.latinFamily)};`,
    `const KR_LETTER_SPACING_PERCENT = ${font.krLetterSpacingPercent};`,
    `const LATIN_LETTER_SPACING_PERCENT = ${font.latinLetterSpacingPercent};`,
    `const FALLBACK_FONT: FontName = { family: ${JSON.stringify(font.fallback.family)}, style: ${JSON.stringify(font.fallback.style)} };`,
    `const LIVE_INLINE_LOGO_HEIGHT_RATIO = ${liveInlineLogo.heightRatio};`,
    `const LIVE_INLINE_LOGO_GAP_RATIO = ${liveInlineLogo.gapRatio};`,
    `const DEFAULT_BACKDROP_BLUR_RADIUS = ${backdrop.defaultBlurRadius};`,
    `const HIGHLIGHT_BADGE_PAD_X_RATIO = ${highlightBadge.paddingXRatio};`,
    `const HIGHLIGHT_BADGE_PAD_Y_RATIO = ${highlightBadge.paddingYRatio};`,
    `const HIGHLIGHT_BADGE_CORNER_RADIUS = ${highlightBadge.cornerRadius};`,
  ].join("\n");
}

// 마커를 찾아 [START 마커까지 포함한 앞부분, END 마커부터 포함한 뒷부분]으로 분리한다.
// 마커가 0개, 한쪽만 있거나, 2개 이상이면(어느 쌍을 치환해야 할지 알 수 없음) 에러로 중단한다.
function locateMarkers(text) {
  const startCount = countOccurrences(text, START_MARKER);
  const endCount = countOccurrences(text, END_MARKER);

  if (startCount === 0 && endCount === 0) {
    throw new Error(
      `code.ts에서 BRAND_CONFIG 마커를 찾지 못했습니다. 다음 두 줄이 있어야 합니다:\n  ${START_MARKER}\n  ${END_MARKER}`,
    );
  }
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `code.ts의 BRAND_CONFIG 마커 개수가 올바르지 않습니다 (START ${startCount}개, END ${endCount}개 — 각각 정확히 ` +
        `1개여야 함). 마커가 누락되었거나 중복되었을 수 있으니 code.ts를 확인할 것.`,
    );
  }

  const startIdx = text.indexOf(START_MARKER);
  const endIdx = text.indexOf(END_MARKER);
  if (endIdx < startIdx) {
    throw new Error("code.ts에서 BRAND_CONFIG_END가 BRAND_CONFIG_START보다 앞에 있습니다. 마커 순서를 확인할 것.");
  }

  return {
    before: text.slice(0, startIdx + START_MARKER.length),
    after: text.slice(endIdx),
  };
}

// 마커 밖 영역이 치환 전후로 100% 동일한지 재검증하는 안전장치. before/after는 원본 텍스트에서 그대로
// 슬라이싱했으므로 이론상 항상 참이어야 하지만, 생성된 블록 안에 마커 문자열이 우연히 다시 등장해
// 재파싱 결과가 어긋나는 경우 등을 잡아내기 위해 결과물을 마커 기준으로 독립적으로 다시 파싱해서 비교한다.
function assertOutsideMarkersUnchanged(originalBefore, originalAfter, newText) {
  const newStartCount = countOccurrences(newText, START_MARKER);
  const newEndCount = countOccurrences(newText, END_MARKER);
  if (newStartCount !== 1 || newEndCount !== 1) {
    throw new Error(
      `안전장치 실패: 치환 결과물에서 마커가 정확히 1개씩 발견되지 않았습니다 (START ${newStartCount}개, ` +
        `END ${newEndCount}개). code.ts를 덮어쓰지 않고 중단합니다.`,
    );
  }

  const newStartIdx = newText.indexOf(START_MARKER);
  const newEndIdx = newText.indexOf(END_MARKER);
  const newBefore = newText.slice(0, newStartIdx + START_MARKER.length);
  const newAfter = newText.slice(newEndIdx);

  if (newBefore !== originalBefore) {
    throw new Error(
      "안전장치 실패: BRAND_CONFIG_START 마커 이전 영역이 치환 과정에서 바뀌었습니다. code.ts를 덮어쓰지 않고 중단합니다.",
    );
  }
  if (newAfter !== originalAfter) {
    throw new Error(
      "안전장치 실패: BRAND_CONFIG_END 마커 이후 영역이 치환 과정에서 바뀌었습니다. code.ts를 덮어쓰지 않고 중단합니다.",
    );
  }
}

function sync() {
  const brandConfig = JSON.parse(fs.readFileSync(BRAND_CONFIG_PATH, "utf-8"));
  const originalText = fs.readFileSync(CODE_TS_PATH, "utf-8");

  const { before, after } = locateMarkers(originalText);
  const block = generateBlock(brandConfig);
  const newText = `${before}\n${block}\n${after}`;

  assertOutsideMarkersUnchanged(before, after, newText);

  if (newText === originalText) {
    console.log("brand.config.json 값과 code.ts의 BRAND_CONFIG 블록이 이미 동일합니다 — 변경 없음.");
    return;
  }

  fs.writeFileSync(CODE_TS_PATH, newText, "utf-8");
  console.log("code.ts의 BRAND_CONFIG 블록을 brand.config.json 값으로 갱신했습니다.");
}

if (require.main === module) {
  sync();
}

module.exports = { locateMarkers, assertOutsideMarkersUnchanged, generateBlock, START_MARKER, END_MARKER };

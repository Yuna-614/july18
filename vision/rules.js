// ============================================================
// 소재 제작 규칙 로더 (알로소 Alloso)
// 이 파일은 더 이상 규칙 "텍스트"를 직접 담지 않는다 — 사람이 읽는 규칙 원문은 프로젝트 루트의
// RULES.md 하나뿐이고, 이 파일은 그걸 읽어서 Gemini 프롬프트용 텍스트로 파싱만 한다.
// 숫자/경로 값(출력 사이즈 등)은 프로젝트 루트의 brand.config.json에서 읽는다.
// 규칙 문구를 바꾸고 싶으면 RULES.md를, 값을 바꾸고 싶으면 brand.config.json을 수정하면 된다.
// ============================================================

const fs = require("fs");
const path = require("path");

const brandConfig = require("../brand.config.json");
const RULES_MD_PATH = path.join(__dirname, "..", "RULES.md");

const OUTPUT_SIZE = brandConfig.outputSize;

const COMMON_START_MARKER = "<!-- RULES_JS:COMMON_RULES:START -->";
const COMMON_END_MARKER = "<!-- RULES_JS:COMMON_RULES:END -->";
const CATEGORY_START_MARKER = "<!-- RULES_JS:CATEGORY_RULES:START -->";
const CATEGORY_END_MARKER = "<!-- RULES_JS:CATEGORY_RULES:END -->";

// RULES.md의 각 규칙 항목에 달린 "- 수정 위치: ..." 불릿은 사람(유지보수자)을 위한 메타 정보일 뿐 —
// 브랜드 규칙 자체가 아니므로 Gemini 프롬프트에는 불필요한 노이즈다(파일/변수명을 언급해 혼동을 줄 수도
// 있음). 이 불릿과 그 아래 들여쓰기된 하위 항목/이어지는 줄만 기계적으로 제거하고, RULES.md 파일 자체는
// 사람이 보는 그대로 손대지 않는다.
function stripMaintenanceNotes(text) {
  const lines = text.split("\n");
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    if (skipping) {
      const isBlank = line.trim() === "";
      if (isBlank) {
        skipping = false;
        kept.push(line);
        continue;
      }
      if (/^\s/.test(line)) {
        // 수정 위치 불릿에 딸린 하위 항목/줄바꿈된 이어지는 줄 — 계속 건너뜀
        continue;
      }
      skipping = false;
      // 들여쓰기 없는 새 줄이 시작됨 — 아래에서 정상적으로 재평가
    }
    if (/^-\s*수정\s*위치/.test(line.trim())) {
      skipping = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function extractBetween(text, startMarker, endMarker, label) {
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `RULES.md에서 ${label} 마커(${startMarker} ~ ${endMarker})를 찾지 못했습니다. RULES.md 구조가 바뀌었는지 확인할 것.`,
    );
  }
  return text.slice(startIdx + startMarker.length, endIdx);
}

// "### 카테고리명" 소제목 기준으로 텍스트를 분리한다 (다음 "### " 소제목 또는 구간 끝까지).
function splitByCategoryHeadings(sectionText) {
  const headingRegex = /^###\s+(.+)$/gm;
  const matches = [...sectionText.matchAll(headingRegex)];
  const categoryRules = {};
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim();
    const contentStart = matches[i].index + matches[i][0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index : sectionText.length;
    categoryRules[name] = sectionText.slice(contentStart, contentEnd).trim();
  }
  return categoryRules;
}

function parseRulesMd() {
  const text = fs.readFileSync(RULES_MD_PATH, "utf-8");

  const commonSection = extractBetween(text, COMMON_START_MARKER, COMMON_END_MARKER, "공통 규칙(COMMON_RULES)");
  const commonRules = stripMaintenanceNotes(commonSection).replace(/\n{3,}/g, "\n\n").trim();

  const categorySection = extractBetween(text, CATEGORY_START_MARKER, CATEGORY_END_MARKER, "카테고리별 규칙(CATEGORY_RULES)");
  const categoryRules = splitByCategoryHeadings(categorySection);

  return { commonRules, categoryRules };
}

const { commonRules: COMMON_RULES, categoryRules: CATEGORY_RULES } = parseRulesMd();

// RULES.md의 "카테고리별 규칙" 소제목에서 그대로 파생됨 — 하드코딩된 목록이 아니므로 RULES.md에 소제목을
// 추가/삭제하면 다음 실행부터 자동으로 반영된다. (참고: 이전에는 영문 키(NAVER, CM29 등)를 가진 객체
// 맵이었으나, 그 키를 참조하는 코드가 없어 카테고리명 배열로 단순화함.)
const CATEGORIES = Object.keys(CATEGORY_RULES);

// 카테고리를 지정하면 공통 규칙 + 해당 카테고리 규칙을 합쳐서 반환한다.
// 카테고리를 지정하지 않으면 공통 규칙만 반환한다 (하위 호환).
// CATEGORY_RULES에 등록되지 않은 카테고리(자동 판별로 완전히 새로운 유형이 나온 경우 등)는
// 에러 대신 공통 규칙만으로 fallback한다 — 새 기획전 유형이 와도 파이프라인이 멈추지 않게 하기 위함.
function getProductionRules(category) {
  if (!category) return COMMON_RULES;
  const categoryRules = CATEGORY_RULES[category];
  if (categoryRules === undefined) {
    console.warn(`등록되지 않은 카테고리("${category}")입니다. 공통 규칙만 적용합니다.`);
    return COMMON_RULES;
  }
  if (!categoryRules.trim()) return COMMON_RULES;
  return `${COMMON_RULES}\n[카테고리: ${category}]\n${categoryRules}`;
}

module.exports = {
  OUTPUT_SIZE,
  CATEGORIES,
  COMMON_RULES,
  CATEGORY_RULES,
  getProductionRules,
  // 하위 호환: 기존에 PRODUCTION_RULES(공통 규칙)를 직접 쓰던 코드용
  PRODUCTION_RULES: COMMON_RULES,
};

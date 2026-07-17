# README 미디어 촬영 리스트

README의 이미지 자리는 전부 `docs/media/<파일명>`을 참조한다. **아래 파일명 그대로** 이 폴더에 넣으면 README에 즉시 나타난다 (README 수정 불필요).

- **GIF**: macOS `⌘⇧5`로 화면 녹화(.mov) → 파일을 주면 GIF/WebP로 변환·최적화해 줌. 또는 [Kap](https://getkap.co)으로 바로 GIF 녹화.
- **PNG**: `⌘⇧4`(영역) 또는 `⌘⇧4 → Space`(창 단위).
- 녹화 전 체크: 테스트용 파일명 사용(개인정보 노출 주의), 라이트 테마 권장(가독성), 패널 폭은 여유 있게.

## 히어로 (최우선 — 이것만 있어도 절반은 완성)

| 파일명 | 종류 | 길이 | 내용 |
|---|---|---|---|
| `hero.gif` | GIF | ~20초 | **전체 플로우 한 방에**: 노트에 큰 파일 드래그 → ⏳ 업로드 진행 → 링크로 교체 → 링크 hover로 미리보기까지. 첫인상 담당 |

## "See it in action" 3종 (두 번째 우선순위)

| 파일명 | 종류 | 길이 | 내용 |
|---|---|---|---|
| `search-insert.gif` | GIF | ~10초 | ⌘P → Search Google Drive → 3~4글자 입력 → 결과(경로 표시) → Enter로 링크 삽입 |
| `drop-upload.gif` | GIF | ~10초 | Finder에서 파일을 에디터로 드롭 → 업로드 → 링크 |
| `panel-browse.gif` | GIF | ~10초 | 패널 열고 폴더 2~3개 더블클릭 탐색, 그리드 뷰 전환(썸네일) |

## Feature manual (기능별 — 여유 될 때 순서대로)

| 파일명 | 종류 | 길이 | 내용 |
|---|---|---|---|
| `editor-drop-flow.gif` | GIF | ~12초 | 에디터 드롭 상세: ⏳ placeholder → 완료 후 링크 교체 클로즈업 |
| `dedup-modal.png` | PNG | — | 같은 파일 재드롭 시 뜨는 dedup 모달 (use existing / upload anyway) |
| `search-modal.gif` | GIF | ~10초 | 검색 모달: 타이핑하며 즉시 결과 갱신, 타입 아이콘 + 회색 경로 잘 보이게 |
| `asset-note.png` | PNG | — | asset note 하나 열어서 frontmatter(Drive ID·size·md5) 보이게 |
| `inline-preview.gif` | GIF | ~10초 | 노트 안 Drive 이미지 썸네일 → hover 미리보기 → 클릭 라이트박스 |
| `panel-tour.gif` | GIF | ~15초 | 패널 좌측 루트 전환: My Drive → Shared with me → Starred → Recent → Trash, 뷰 3종 전환 |
| `panel-navigation.gif` | GIF | ~10초 | 브레드크럼 클릭/형제 메뉴, 주소창 편집, ←→↑ 버튼 |
| `panel-keyboard.gif` | GIF | ~12초 | 마우스 없이: 방향키 이동 → 타이핑 점프 → F2 rename → Ctrl+Enter 메뉴 → Shift 다중선택 |
| `panel-search.gif` | GIF | ~15초 | 패널 검색: 입력 → "Search results" 브레드크럼 → Location/Type 칩 → 결과 우클릭 Open location |
| `panel-organize.gif` | GIF | ~12초 | 우클릭 메뉴: rename → move(폴더 picker) → star |
| `folder-colors.png` | PNG | — | 색깔 입힌 폴더 여러 개가 보이는 목록 + 색 선택 팔레트 |
| `panel-upload.gif` | GIF | ~15초 | 폴더+파일 동시 드롭 → 하단 진행 카드(대상/진행/Cancel) → 업로드 중 추가 드롭 → "queued" 줄 |
| `panel-trash.png` | PNG | — | Trash 뷰: date trashed 정렬 + 우클릭 Restore/Delete forever 메뉴 |
| `picker.png` | PNG | — | Google Picker 창이 뜬 모습 |
| `migrate.gif` | GIF | ~12초 | 마이그레이션: dry-run 미리보기 → 실행 → 링크 재작성 |
| `icons-themes.png` | PNG | — | 아이콘 테마/커스텀 팩이 적용된 파일 목록 비교 |
| `settings-connected.png` | PNG | — | 연결 완료 상태의 설정 화면 (Client ID 등은 가리고) |

## 변환 명령 참고 (내가 처리해 주지만, 직접 할 경우)

```bash
# .mov → 최적화 GIF (720px, 12fps)
ffmpeg -i in.mov -vf "fps=12,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" out.gif
```

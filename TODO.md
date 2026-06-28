# 향후 할 일 (TODO)

> 아직 구현하지 않은, 다음에 다시 문의해서 진행할 작업 목록.

## 1. 모바일 화면 — 범례(FIT 트랙 목록) UI 개선 — ✅ 완료

- 모바일(화면 폭 600px 이하)에서 범례 폰트/항목 크기를 줄이고, FIT 트랙 목록(`#legend-tracks`)을 별도 스크롤 영역으로 분리(`docs/app.js`, `docs/style.css`).
- 헤드리스 브라우저로 375x667 모바일 뷰포트에서 목록 영역 높이(약 93px) < 실제 콘텐츠 높이(약 221px)로 스크롤 발생을 확인.

## 2. 미분류 영상 중 FIT 시작/끝 지점과 가까운 경우 마커 표시 — ✅ 완료

- `scripts/build_data.py`: 영상이 어떤 FIT 트랙 범위에도 안 들 때, 가장 가까운 트랙의 시작/끝 지점과 **1시간(`BOUNDARY_MATCH_THRESHOLD`) 이내**면 미분류 대신 해당 경계 지점에 매칭(`boundaryMatch: true`, `estimated: false`)하도록 변경. 1시간보다 더 멀면 기존처럼 미분류 처리.
- 결과: 미분류 106→72개로 감소(34개가 경계 매칭으로 전환). 매칭 222→256개.
- `docs/app.js`: 패널에 "(트랙 경계 지점)" 태그로 일반 매칭과 구분 표시, 범례의 "위치 추정" 설명도 "1시간 이상 차이"로 문구 수정.

## 3. 새 경로/영상 업로드를 위한 웹페이지 UI (향후 핵심 기능) — ✅ 완료 (서버 없이 동작)

- 사용자가 웹페이지에서 직접:
  1. FIT 파일을 추가하면, 날짜 기반 이름(`20260702_{라이딩 타이틀}`)으로 새 경로가 생성·적용됨. 가민 커넥트("Export Original")나 스트라바("Export GPX")에서 내려받은 FIT 파일을 그대로 업로드하는 방식. 범례에 경로 이름 입력 + "FIT 경로 추가" 버튼.
  2. "영상 파일 선택" 버튼으로 영상을 고르면 FIT 트랙과 자동 매칭 + 유튜브 업로드까지 처리. 어떤 기기에서든(모바일 포함) 동작.
- **2026-06-28 업데이트: 로컬 서버(`scripts/youtube_upload_server.py`)를 완전히 제거하고 브라우저가 직접 유튜브/GitHub와 통신하도록 변경.**
  - 유튜브 업로드: Google Identity Services OAuth + 자체 구현한 resumable upload (`docs/youtube-upload.js`). `docs/youtube-upload.js`의 `GOOGLE_CLIENT_ID`는 placeholder 상태 — 구글 클라우드 콘솔에서 Web application용 OAuth 클라이언트(Authorized JavaScript origins: `https://netscomm.github.io`)를 만들어 실제 ID로 교체해야 동작함.
  - FIT 파싱: `docs/fit-parser.js` (브라우저에서 직접 파싱, `build_data.py`의 `parse_fit_file()`과 기존 FIT 11개 전부 포인트 수/시작·끝 시각 정확히 일치 확인).
  - 영상 촬영 시각/길이: `docs/mp4-meta.js` (ffprobe 없이 MP4 moov/mvhd 박스를 직접 읽음, 실제 DJI 파일들로 ffprobe와 일치 확인, 17GB 파일도 10ms 내).
  - 결과 저장: `docs/github-api.js`로 GitHub Contents API를 호출해 `docs/data.js`/`docs/youtube_map.js`에 직접 커밋 (더 이상 수동 git push 불필요). GitHub PAT는 페이지 로드마다 새로 입력받고 저장하지 않음.
  - "새 영상 스캔"(이 PC 전용 폴더 스캔) 기능은 제거됨 — "영상 파일 선택"이 유일한 영상 추가 경로이며 처음부터 기기 무관하게 동작.
  - `scripts/youtube_upload_server.py` 삭제. 거기 있던 OAuth/`youtube_map.js` 헬퍼는 `scripts/youtube_helpers.py`로 옮겨서 기존 로컬 배치 스크립트(`bulk_upload_youtube.py`, `upload_from_videos.py`)는 그대로 사용 가능.
- Strava/Garmin "링크만 붙여넣으면 자동 가져오기"는 아직 미구현 — 스트라바는 [API 개발자 앱 등록](https://developers.strava.com) + OAuth로 가능(개인 계정만 쓰면 앱 심사 불필요), 가민 커넥트는 개인용 공개 API가 없어서 FIT 직접 내보내기가 현실적인 방법. 필요해지면 별도로 설계.

## 4. FIT 트랙 목록을 국가별 탭으로 관리 — ✅ 완료

- `scripts/build_data.py`: 각 FIT 트랙의 첫 지점 위경도로 국가를 자동 판별(`detect_country`, 한국/이탈리아/프랑스/스페인/미국 대략적인 bounding box, 그 외는 "기타"). 트랙에 `country`/`countryLabel` 필드 추가.
- `docs/app.js`, `docs/style.css`: 범례에 국가 탭(`#legend-country-tabs`) 추가, 탭 클릭 시 해당 국가의 트랙만 `#legend-tracks`에 표시. 경로가 있는 국가는 1개여도 항상 탭으로 표시(현재는 "이탈리아" 탭 하나). 헤드리스 브라우저에서 가상으로 2개 국가 상황을 만들어 탭 표시/필터링 동작을 확인.
- 참고: bounding box 기반 판별이라 국경 인접 지역은 부정확할 수 있음 — 추후 정밀하게 하려면 reverse-geocoding API 연동 필요(3번 항목과 함께 고려).

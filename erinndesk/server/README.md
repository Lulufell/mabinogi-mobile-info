# 에린데스크 디스코드 서버

이 폴더가 서버의 Git 관리 원본입니다. 이전 Codex outputs/erinn-remote 폴더에서 배포하지 마세요.
기존 운영 Worker erinn-desk-remote, RemoteHub 바인딩/마이그레이션, pilot-v1 저장소를 유지합니다.
앱 EXE 및 다운로드 페이지는 이 워크플로의 배포 대상이 아닙니다.

## 최초 설정
1. Cloudflare에서 Workers 배포용 API 토큰을 발급합니다. Edit Cloudflare Workers 템플릿을 출발점으로 사용하고, 이 Worker가 속한 계정으로 리소스 범위를 제한하세요. 현재 workers.dev만 사용하므로 별도 도메인 라우트 설정은 필요하지 않습니다. Global API Key나 개인 OAuth 토큰을 복사하지 마세요.
2. Cloudflare 계정 ID를 확인합니다.
3. GitHub 저장소 Settings → Environments → New environment에서 `erinn-production`을 만듭니다. Deployment branches는 main만 허용하도록 설정합니다. 매번 승인 없는 자동 배포를 원하면 Required reviewers는 추가하지 않습니다. 계정/저장소 요금제에 따라 환경 보호 옵션 제공 범위는 다를 수 있습니다.
4. 해당 환경의 Environment secrets에 다음 두 항목을 등록합니다.
   - `CLOUDFLARE_API_TOKEN`: 위에서 발급한 토큰
   - `CLOUDFLARE_ACCOUNT_ID`: 해당 Cloudflare 계정 ID
5. 아래 신규 파일만 커밋하고 main에 push합니다. 기존에 삭제된 웹 파일은 이 변경에 포함하지 마세요.

```powershell
cd D:\Project\mabinogi-mobile-info
git add -- .github/workflows/erinndesk-server.yml erinndesk/server
git diff --cached --stat
git commit -m "Set up Erinn Desk server deployment"
git push origin main
```

토큰은 코드/문서/채팅에 넣지 않고 GitHub Secret 입력창에만 입력합니다.
서버 배포 후 명령 자동 등록을 위해 `DISCORD_BOT_TOKEN`도 같은 환경의 Secret에 등록합니다. Discord 공개 키와 앱/서버 ID는 비밀 인증정보가 아닙니다.
현재 저장소의 공개/비공개 설정은 변경하지 않았습니다. push하면 이 서버 코드도 기존 저장소의 공개 범위를 따릅니다.

## 자동 실행
- 서버 폴더 또는 해당 workflow가 바뀐 PR: 테스트 + 배포 dry-run. 운영 인증정보는 전달하지 않음.
- 해당 변경이 main에 push: 위 검증 통과 후 운영 배포.
- GitHub Actions → Erinn Desk server → Run workflow → main: 수동 재배포.
- 그 외 브랜치에서 수동 실행하면 검증만 수행.
- 동일 브랜치 실행은 동시에 배포하지 않음. GitHub concurrency 특성상 대기 중인 실행은 더 최신 실행으로 대체될 수 있음.
- 배포 완료 후 /health의 commit이 GitHub 커밋과 같은지 확인. 실패는 Actions에 표시하며 자동 롤백하지 않음.
- 서버 상태 확인 성공 후 DISCORD_BOT_TOKEN으로 Discord 명령 목록을 자동 등록합니다. 실패 시 Actions 실패로 표시하며 이미 배포한 서버는 유지합니다. 앱 EXE 빌드는 별도 작업.

## 수동 명령
Node.js 24, pnpm 11.25.0을 기준으로 합니다. lockfile을 고정 설치합니다.

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run check:deploy
pnpm run deploy
```

현재 PC에서는 기존 관리자 도구도 사용할 수 있습니다.

```powershell
cd D:\Project\mabinogi-mobile-info\erinndesk\server
.\관리자도구.ps1 deploy
```

## 운영 확인 및 복구
- 상태: https://erinn-desk-remote.lulufell.workers.dev/health
- 수동 배포는 commit이 local로 표시될 수 있습니다. Actions 배포는 SHA가 기록됩니다.
- Cloudflare Worker의 Deployments에서 이전 정상 버전을 확인하고 필요 시 롤백합니다. Durable Object 데이터 변경은 코드 롤백으로 되돌아가지 않습니다. 저장소 구조 변경은 별도 검토가 필요합니다.
- 기존 테스트 등록 삭제용 REGISTRATION_RESET_EPOCH와 초기화 경로를 소스에서 제거했습니다. 일반 배포/health 요청으로 등록을 초기화하지 않습니다.
- 서버 이름, RemoteHub 클래스/바인딩, 기존 migration v1, pilot-v1을 임의로 변경하면 기존 데이터 접근에 영향을 줄 수 있습니다.

## 검증
2026-10-09: 고정 lockfile 설치, 서버 테스트 25개, Wrangler deploy --dry-run 통과.
실제 GitHub Actions 실행은 Secrets 등록 및 push 후 확인해야 합니다. 이번 구성 작업에서 운영 배포/커밋/push는 하지 않았습니다.

공식 참고: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/

## /테스트 명령 (2026-10-13)
PC 연결 없이 서버 응답과 배포 커밋 앞 12자(수동 배포는 "수동 배포")를 요청자에게만 표시합니다. 기존 서명/전용 서버 검사와 사용자당 분당 10회 제한을 적용합니다. 게임 조회나 스크린샷을 요청하지 않습니다.
서버 코드를 배포한 뒤 아래 명령으로 Discord 명령 목록도 갱신해야 /테스트가 표시됩니다. Bot Token은 터미널의 숨김 입력창에만 입력합니다.

```powershell
cd D:\Project\mabinogi-mobile-info\erinndesk\server
python manage.py register
```

27개 테스트 및 배포 dry-run 통과. 이 변경 작업에서 커밋/push/운영 서버 배포/Discord 명령 등록은 수행하지 않았습니다.


## 명령 자동 등록 (2026-10-13)
`erinn-production` 환경 Secrets에 `DISCORD_BOT_TOKEN`을 추가하면 이후 main push/수동 워크플로 실행에서 서버 확인 후 명령이 자동 갱신됩니다. 위 /테스트의 수동 등록 안내는 선택 사항이며 더 이상 필수가 아닙니다.
manage.py의 COMMANDS가 해당 전용 서버의 전체 명령 목록입니다. 목록에서 제거한 명령은 등록 시 Discord에서도 삭제됩니다.
PR 테스트에는 봇 토큰을 전달하지 않습니다. CI에서 토큰이 없으면 입력 대기 없이 실패합니다. 로컬 실행은 기존 숨김 입력을 지원합니다. 모의 HTTP 테스트 4개 통과(실제 봇 호출 없음).

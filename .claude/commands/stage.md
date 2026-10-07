---
description: 특정 차수 하나를 끝까지 수행 (예: /stage S05)
argument-hint: S00 ~ S32
---
수행할 차수: $ARGUMENTS

CLAUDE.md와 prompts/_PROTOCOL.md를 따르고, prompts/ 폴더에서 이름이 위 차수 ID로 시작하는 파일(예: S05 → S05_server_foundation.md)을 찾아 그 차수를 끝까지 수행하라. 차수 ID가 숫자만이면 S와 두 자리로 맞춘다(예: 5 → S05). 그 차수가 IN_PROGRESS로 중단된 상태라면 prompts/RESUME.md를 먼저 따른다. 사람은 자리에 없다고 가정하고 질문하지 말 것. 단, S00을 실행 중이고 사람이 대화창에 있다면 도구 설치에 필요한 확인은 받아도 된다.

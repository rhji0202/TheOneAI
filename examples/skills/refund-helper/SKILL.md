---
name: refund-helper
description: 주문의 환불 · 반품 가능 여부와 예상 환불 금액을 계산해 안내합니다. 환불, 반품, 돌려받을 금액 문의에 사용.
allowed-tools: demo-shop.lookup_order builtin.calculate
version: 1.0.0
title: 환불 금액 확인
example_prompt: 주문 A-1003 단순 변심으로 환불하면 얼마 받아요?
---

# 환불 안내 절차

1. 주문 번호가 있으면 `demo-shop.lookup_order` 로 주문 상태 · 상품 · 택배사를 확인한다. 주문 번호가 없으면 계산하지 말고 주문 번호가 필요하다고 적는다.
2. `references/refund-policy.md` 를 읽고 사유(단순 변심 · 상품 불량 · 오배송)와 주문 상태에 맞는 규정을 찾는다.
3. 상품 가격을 알면 `builtin.calculate` 로 예상 환불 금액을 계산한다. 가격을 모르면 계산식만 적는다.
4. 노트에는 다음을 남긴다.
   - 환불 가능 여부와 근거 규정 (규정 문서의 항목 번호)
   - 계산식과 예상 환불 금액
   - 고객이 해야 할 일 (신청 방법 · 기한)
5. 환불 신청을 대신 접수하지 않는다. 접수는 고객이 마이페이지 또는 고객센터에서 한다고 안내한다.

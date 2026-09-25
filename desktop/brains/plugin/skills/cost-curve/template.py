"""
Cost Curve Router — трёхуровневый LLM-роутер.

Скопируй этот файл в проект и адаптируй под задачу:
1. В tier1_check — поставь детерминированные проверки
2. В tier2_check — напиши triage-промпт для Haiku (нужен ли Tier 3?)
3. В tier3_check — напиши полный промпт для Sonnet/Opus
4. В audit — подключи к своей логике через флаг tiered=True

Единая JSON-схема ответа:
{
    "id": str,          # уникальный идентификатор входа
    "status": str,      # PASS / FAIL / WARN
    "flags": list[str], # список найденных проблем
    "method": str,      # deterministic / haiku / haiku-fallback / sonnet / sonnet-fallback
    "needs_tier3": bool,# для внутреннего роутинга
    "details": dict,    # доп. данные, специфичные для задачи
}
"""

import json
import os
import anthropic

# Конфиг моделей в одном месте — не инлайн в коде
HAIKU_MODEL = "claude-sonnet-5"  # пользователь 15.09.26: Haiku не используем
SONNET_MODEL = "claude-sonnet-4-6"


def _build_result(data: dict, method: str) -> dict:
    """Скелет ответа — единая схема для всех уровней."""
    return {
        "id": data.get("id", ""),
        "status": "PASS",
        "flags": [],
        "method": method,
        "needs_tier3": False,
        "details": {},
    }


# ─────────────────────────────────────────────
# Tier 1 — детерминированная логика, стоимость $0
# Запускается ВСЕГДА (формирует скелет ответа)
# ─────────────────────────────────────────────
def tier1_check(data: dict) -> dict:
    result = _build_result(data, "deterministic")

    # TODO: замени на свои механические проверки
    # Пример: проверка title для SEO-аудита
    title = data.get("title") or ""
    result["details"]["title_length"] = len(title)

    if not title:
        result["status"] = "FAIL"
        result["flags"].append("title отсутствует")
    elif len(title) > 60:
        result["status"] = "FAIL"
        result["flags"].append(f"title {len(title)} символов (макс 60)")

    # Добавь другие детерминированные проверки здесь:
    # - регексы
    # - длина строк
    # - наличие обязательных полей
    # - арифметику (overall_score по формуле)

    return result


# ─────────────────────────────────────────────
# Tier 2 — быстрая сортировка через Haiku, ~$0.0001
# Включается только если Tier 1 нашёл аномалию
# Задача: решить нужен ли Tier 3, не генерировать контент
# ─────────────────────────────────────────────
def tier2_check(data: dict) -> dict:
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    # TODO: адаптируй промпт под свою задачу
    # Принцип: максимально короткий вопрос, бинарный ответ
    title = data.get("title") or ""

    prompt = f"""Ты аудитор на triage-проверке.
Title: {title}
Вопрос: требует ли этот title семантической оценки (нестандартный язык, аббревиатуры, контекстная неоднозначность)?
Верни только JSON: {{"needs_tier3": true или false}}"""

    try:
        response = client.messages.create(
            model=HAIKU_MODEL,
            max_tokens=100,
            messages=[{"role": "user", "content": prompt}],
        )
        parsed = json.loads(response.content[0].text.strip())

        result = tier1_check(data)
        result["needs_tier3"] = parsed.get("needs_tier3", False)
        result["method"] = "haiku"
        return result

    except Exception:
        # Graceful fallback → Tier 1 с пометкой в логах
        fallback = tier1_check(data)
        fallback["method"] = "haiku-fallback"
        return fallback


# ─────────────────────────────────────────────
# Tier 3 — полный анализ через Sonnet/Opus, ~$0.006
# Запускается только если Haiku сказал needs_tier3=True
# ─────────────────────────────────────────────
def tier3_check(data: dict) -> dict:
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    # TODO: замени на свой полный промпт
    title = data.get("title") or ""

    prompt = f"""Ты SEO-эксперт. Оцени title страницы.
Title: {title}

Верни JSON:
{{
    "status": "PASS" или "FAIL" или "WARN",
    "issues": ["список проблем если есть"],
    "recommendation": "короткая рекомендация"
}}"""

    try:
        response = client.messages.create(
            model=SONNET_MODEL,
            max_tokens=500,
            messages=[{"role": "user", "content": prompt}],
        )
        parsed = json.loads(response.content[0].text.strip())

        result = tier1_check(data)  # берём Tier 1 как базу
        result["status"] = parsed.get("status", result["status"])
        result["flags"].extend(parsed.get("issues", []))
        result["details"]["recommendation"] = parsed.get("recommendation", "")
        result["method"] = "sonnet"
        return result

    except Exception:
        # Graceful fallback → Tier 2
        fallback = tier2_check(data)
        fallback["method"] = "sonnet-fallback"
        return fallback


# ─────────────────────────────────────────────
# Роутер — единая точка входа
# tiered=False: старое поведение (только Tier 3), для легаси
# tiered=True:  новый роутинг по кривой затрат
# ─────────────────────────────────────────────
def audit(data: dict, tiered: bool = False) -> dict:
    if not tiered:
        # Режим совместимости — поведение до внедрения cost curve
        return tier3_check(data)

    # Tier 1: всегда прогоняем
    t1 = tier1_check(data)

    # Решаем: есть ли аномалия, требующая нейросети?
    # TODO: замени на свои условия эскалации
    title = data.get("title") or ""
    needs_tier2 = bool(title) and (len(title) < 10 or len(title) > 60)

    if not needs_tier2:
        return t1  # задача решена бесплатно

    # Tier 2: triage через Haiku
    t2 = tier2_check(data)
    if not t2.get("needs_tier3"):
        return t2  # Haiku справился

    # Tier 3: полный анализ
    return tier3_check(data)


# ─────────────────────────────────────────────
# Тесты — запустить через: python -m pytest template.py
# ─────────────────────────────────────────────
if __name__ == "__main__":
    import unittest
    from unittest.mock import MagicMock, patch

    class TestCostCurve(unittest.TestCase):
        def test_clean_page_zero_api_calls(self):
            """Чистая страница с нормальным title — 0 API-вызовов."""
            data = {"id": "test-1", "title": "Купить диван в Москве"}
            with patch("anthropic.Anthropic") as mock_cls:
                result = audit(data, tiered=True)
            mock_cls.assert_not_called()
            self.assertEqual(result["status"], "PASS")
            self.assertEqual(result["method"], "deterministic")

        def test_short_title_triggers_haiku(self):
            """Подозрительно короткий title — ровно один Haiku-вызов."""
            data = {"id": "test-2", "title": "SEO"}
            mock_client = MagicMock()
            mock_client.messages.create.return_value = MagicMock(
                content=[MagicMock(text='{"needs_tier3": false}')]
            )
            with patch("anthropic.Anthropic", return_value=mock_client):
                result = audit(data, tiered=True)
            mock_client.messages.create.assert_called_once()
            self.assertEqual(result["method"], "haiku")

        def test_haiku_fallback_on_api_error(self):
            """При ошибке Haiku — откат к Tier 1, метод помечается."""
            data = {"id": "test-3", "title": "X"}
            with patch("anthropic.Anthropic", side_effect=Exception("timeout")):
                result = tier2_check(data)
            self.assertEqual(result["method"], "haiku-fallback")

        def test_legacy_mode_always_calls_sonnet(self):
            """tiered=False — старое поведение, Sonnet вызывается всегда."""
            data = {"id": "test-4", "title": "Нормальный тайтл страницы"}
            mock_client = MagicMock()
            mock_client.messages.create.return_value = MagicMock(
                content=[MagicMock(text='{"status": "PASS", "issues": [], "recommendation": "ok"}')]
            )
            with patch("anthropic.Anthropic", return_value=mock_client):
                result = audit(data, tiered=False)
            mock_client.messages.create.assert_called_once()
            self.assertEqual(result["method"], "sonnet")

    unittest.main(verbosity=2)

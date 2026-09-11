"""로그인·접근 거부 일일 감사 기록 — /api/me의 dedupe 규칙. / daily login/denied audit rows."""

from sqlalchemy.orm import sessionmaker

from app.api.me import _record_daily
from app.models import AuditLog


def test_daily_record_dedupes_per_action(migrated_engine):
    # Arrange / Act: 같은 사람의 접근 거부 두 번 + 로그인 한 번
    with sessionmaker(bind=migrated_engine)() as db:
        _record_daily(db, "access_denied", "park.min")
        _record_daily(db, "access_denied", "park.min")
        _record_daily(db, "login", "park.min")
        db.commit()

        # Assert: 동작별로 하루 한 건, target은 login_id
        rows = db.query(AuditLog).order_by(AuditLog.id).all()
    assert [(row.action, row.target, row.requested_by) for row in rows] == [
        ("access_denied", "park.min", "park.min"),
        ("login", "park.min", "park.min"),
    ]

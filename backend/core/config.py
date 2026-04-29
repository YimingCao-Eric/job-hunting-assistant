from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    database_url: str
    redis_url: str | None = None
    config_path: str = "/app/data/config.json"
    profile_path: str = "/app/data/profile.json"
    extension_origin_regex: str = r"^chrome-extension://[a-zA-Z0-9]+$"
    dedup_cosine_batch_size: int = 1000
    debug_log_ring_size: int = 10000


settings = Settings()

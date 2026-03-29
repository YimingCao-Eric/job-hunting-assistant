from fastapi import Header, HTTPException


async def get_current_user(authorization: str = Header(None)) -> dict:
    if authorization == "Bearer dev-token":
        return {"user_id": "dev_user_001"}
    raise HTTPException(status_code=401, detail="Unauthorized")

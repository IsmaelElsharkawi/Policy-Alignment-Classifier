"""`uv run policyguard` (or `python -m policyguard`) — run the API server."""

import logging

import uvicorn

from .config import settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    uvicorn.run("policyguard.app:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()

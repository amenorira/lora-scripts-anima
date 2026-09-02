import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

from backend.server import proxy


class TensorBoardProxyTests(unittest.TestCase):
    def test_client_disconnect_does_not_escape_asgi_application(self):
        app = FastAPI()
        app.include_router(proxy.router)

        with patch.object(
            proxy,
            "_get_client",
            return_value=type(
                "Client",
                (),
                {
                    "build_request": lambda self, *args, **kwargs: object(),
                    "send": AsyncMock(side_effect=ClientDisconnect()),
                },
            )(),
        ):
            response = TestClient(app, raise_server_exceptions=False).get("/proxy/tensorboard/")

        self.assertEqual(response.status_code, 499)

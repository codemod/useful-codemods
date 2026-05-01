from web3.middleware import ENSNameToAddressMiddleware, ExtraDataToPOAMiddleware
from web3 import AsyncWeb3, WebSocketProvider
from web3.types import StateOverride
from web3.datastructures import AttributeDict

async def main():
    w3 = WebSocketProvider("ws://127.0.0.1:8546")
    w3.socket.process_subscriptions()
    result = dict({"hash": "0x123"})

class CustomLoggerMiddleware(Web3Middleware):
    def request_processor(self, method, params):
        print(f"Request: {method}")
        return method, params

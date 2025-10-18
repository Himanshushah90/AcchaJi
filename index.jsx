import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';
import { 
    getFirestore, 
    collection, 
    addDoc, 
    onSnapshot, 
    query, 
    orderBy, 
    serverTimestamp,
    doc,
    setDoc
} from 'firebase/firestore';

// --- Firebase Configuration ---
// These global variables are provided by the environment.
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-secure-chat';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// --- Initialize Firebase ---
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- Cryptography Helper Functions (Web Crypto API) ---

// Derives a key from a password/string for AES-GCM
async function getKey(secretKeyString) {
    const encoder = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        'raw',
        encoder.encode(secretKeyString),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode('a-secure-salt-for-your-homies'), // A static salt is okay here since keys are unique per room
            iterations: 100000,
            hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
}

// Encrypts a message with the derived key
async function encryptMessage(text, key) {
    const encoder = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); // Initialization Vector
    const encryptedData = await window.crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: iv,
        },
        key,
        encoder.encode(text)
    );
    // Return IV and encrypted data as base64 strings for easy storage in Firestore
    return {
        iv: btoa(String.fromCharCode.apply(null, iv)),
        data: btoa(String.fromCharCode.apply(null, new Uint8Array(encryptedData))),
    };
}

// Decrypts a message with the derived key
async function decryptMessage(encrypted, iv, key) {
    try {
        const ivArray = new Uint8Array(atob(iv).split('').map(char => char.charCodeAt(0)));
        const dataArray = new Uint8Array(atob(encrypted).split('').map(char => char.charCodeAt(0)));
        
        const decryptedData = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: ivArray,
            },
            key,
            dataArray
        );

        const decoder = new TextDecoder();
        return decoder.decode(decryptedData);
    } catch (e) {
        console.error('Decryption failed:', e);
        return '🔒 Failed to decrypt message';
    }
}


// --- React Components ---

const UserIcon = ({ name }) => {
    const initial = name ? name.charAt(0).toUpperCase() : '?';
    const colors = [
        'bg-red-500', 'bg-green-500', 'bg-blue-500', 'bg-yellow-500', 
        'bg-purple-500', 'bg-pink-500', 'bg-indigo-500', 'bg-teal-500'
    ];
    // Simple hash to get a consistent color for a name
    const colorIndex = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;

    return (
        <div className={`w-10 h-10 rounded-full ${colors[colorIndex]} flex items-center justify-center text-white font-bold text-xl flex-shrink-0`}>
            {initial}
        </div>
    );
};

const ChatMessage = ({ message, isSender }) => {
    const { text, senderName, timestamp } = message;
    const alignment = isSender ? 'items-end' : 'items-start';
    const bubbleColor = isSender ? 'bg-blue-600' : 'bg-gray-700';
    const time = timestamp?.toDate() ? timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    
    return (
        <div className={`flex flex-col my-2 ${alignment}`}>
            <div className="flex items-center gap-3">
                {!isSender && <UserIcon name={senderName} />}
                <div className={`max-w-xs md:max-w-md lg:max-w-lg p-3 rounded-2xl ${bubbleColor} text-white`}>
                    {!isSender && <p className="text-xs text-blue-300 font-bold mb-1">{senderName}</p>}
                    <p className="text-base break-words">{text}</p>
                </div>
                 {isSender && <UserIcon name={senderName} />}
            </div>
            <p className={`text-xs text-gray-400 mt-1 ${isSender ? 'mr-14' : 'ml-14'}`}>{time}</p>
        </div>
    );
};

const ChatRoomScreen = ({ user, roomInfo, onLeave }) => {
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [cryptoKey, setCryptoKey] = useState(null);
    const messagesEndRef = useRef(null);

    useEffect(() => {
        if (roomInfo.key) {
            getKey(roomInfo.key).then(setCryptoKey);
        }
    }, [roomInfo.key]);

    useEffect(() => {
        if (!cryptoKey) return;
        
        const messagesPath = `/artifacts/${appId}/public/data/chatRooms/${roomInfo.id}/messages`;
        const q = query(collection(db, messagesPath), orderBy('timestamp'));

        const unsubscribe = onSnapshot(q, async (querySnapshot) => {
            const msgs = await Promise.all(
                querySnapshot.docs.map(async (doc) => {
                    const data = doc.data();
                    const decryptedText = await decryptMessage(data.text, data.iv, cryptoKey);
                    return { id: doc.id, ...data, text: decryptedText };
                })
            );
            setMessages(msgs);
        });

        return () => unsubscribe();
    }, [cryptoKey, roomInfo.id]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (newMessage.trim() === '' || !cryptoKey) return;

        const { iv, data: encryptedText } = await encryptMessage(newMessage, cryptoKey);

        const messagesPath = `/artifacts/${appId}/public/data/chatRooms/${roomInfo.id}/messages`;
        await addDoc(collection(db, messagesPath), {
            text: encryptedText,
            iv: iv,
            senderId: user.uid,
            senderName: user.nickname,
            timestamp: serverTimestamp(),
        });

        setNewMessage('');
    };
    
    const copyToClipboard = (text) => {
        const el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
    };

    return (
        <div className="flex flex-col h-screen bg-gray-900 text-white">
            <header className="flex items-center justify-between p-4 bg-gray-800 border-b border-gray-700 shadow-md">
                <button onClick={onLeave} className="p-2 rounded-full hover:bg-gray-700 transition">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                </button>
                <div className="text-center">
                    <h1 className="text-xl font-bold truncate">{roomInfo.name}</h1>
                    <p className="text-xs text-gray-400">Room ID: {roomInfo.id}</p>
                </div>
                <div className="w-10"></div>
            </header>
            
            <div className="p-4 bg-yellow-900 bg-opacity-30 text-yellow-200 text-sm mb-2 rounded-lg m-4">
                 <p className="font-bold mb-2">Share these details with your friends:</p>
                 <div className="flex flex-col gap-2">
                     <div className="flex justify-between items-center">
                         <span className="font-mono bg-gray-800 p-1 rounded">ID: {roomInfo.id}</span>
                         <button onClick={() => copyToClipboard(roomInfo.id)} className="bg-blue-600 text-white px-2 py-1 text-xs rounded hover:bg-blue-700 transition">Copy</button>
                     </div>
                      <div className="flex justify-between items-center">
                         <span className="font-mono bg-gray-800 p-1 rounded">KEY: {roomInfo.key}</span>
                         <button onClick={() => copyToClipboard(roomInfo.key)} className="bg-blue-600 text-white px-2 py-1 text-xs rounded hover:bg-blue-700 transition">Copy</button>
                     </div>
                 </div>
            </div>

            <main className="flex-1 overflow-y-auto p-4">
                {messages.map((msg) => (
                    <ChatMessage key={msg.id} message={msg} isSender={msg.senderId === user.uid} />
                ))}
                <div ref={messagesEndRef} />
            </main>

            <footer className="p-4 bg-gray-800 border-t border-gray-700">
                <form onSubmit={handleSendMessage} className="flex items-center gap-4">
                    <input
                        type="text"
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Type a secure message..."
                        className="flex-1 p-3 bg-gray-700 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                    />
                    <button type="submit" className="p-3 bg-blue-600 rounded-full hover:bg-blue-700 transition disabled:bg-gray-600" disabled={!newMessage.trim()}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                    </button>
                </form>
            </footer>
        </div>
    );
};

const RoomSelectionScreen = ({ onCreate, onJoin }) => {
    const [newRoomName, setNewRoomName] = useState('');
    const [joinRoomId, setJoinRoomId] = useState('');
    const [joinRoomKey, setJoinRoomKey] = useState('');

    const handleCreate = (e) => {
        e.preventDefault();
        if (newRoomName.trim()) {
            onCreate(newRoomName.trim());
        }
    };

    const handleJoin = (e) => {
        e.preventDefault();
        if (joinRoomId.trim() && joinRoomKey.trim()) {
            onJoin({ id: joinRoomId.trim(), key: joinRoomKey.trim() });
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white p-4">
            <div className="w-full max-w-md space-y-8">
                <div className="text-center">
                    <h1 className="text-4xl font-bold text-blue-400">Secure Chat</h1>
                    <p className="text-gray-400 mt-2">Create a new room or join an existing one.</p>
                </div>

                <div className="bg-gray-800 p-8 rounded-lg shadow-xl">
                    <h2 className="text-2xl font-semibold mb-6 text-center">Create a Room</h2>
                    <form onSubmit={handleCreate} className="space-y-4">
                        <input
                            type="text"
                            value={newRoomName}
                            onChange={(e) => setNewRoomName(e.target.value)}
                            placeholder="Enter new room name"
                            className="w-full p-3 bg-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                        />
                        <button type="submit" className="w-full p-3 bg-blue-600 rounded-md font-bold hover:bg-blue-700 transition disabled:bg-gray-600" disabled={!newRoomName.trim()}>
                            Create & Enter
                        </button>
                    </form>
                </div>

                <div className="bg-gray-800 p-8 rounded-lg shadow-xl">
                    <h2 className="text-2xl font-semibold mb-6 text-center">Join a Room</h2>
                    <form onSubmit={handleJoin} className="space-y-4">
                        <input
                            type="text"
                            value={joinRoomId}
                            onChange={(e) => setJoinRoomId(e.target.value)}
                            placeholder="Enter Room ID"
                            className="w-full p-3 bg-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                        />
                        <input
                            type="password"
                            value={joinRoomKey}
                            onChange={(e) => setJoinRoomKey(e.target.value)}
                            placeholder="Enter Secret Key"
                            className="w-full p-3 bg-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                        />
                        <button type="submit" className="w-full p-3 bg-green-600 rounded-md font-bold hover:bg-green-700 transition disabled:bg-gray-600" disabled={!joinRoomId.trim() || !joinRoomKey.trim()}>
                            Join Room
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};

const LoginScreen = ({ onLogin }) => {
    const [nickname, setNickname] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (nickname.trim()) {
            onLogin(nickname.trim());
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white p-4">
            <div className="w-full max-w-sm">
                <div className="text-center mb-8">
                    <h1 className="text-4xl font-bold text-blue-400">Welcome!</h1>
                    <p className="text-gray-400 mt-2">Choose a nickname to get started.</p>
                </div>
                <div className="bg-gray-800 p-8 rounded-lg shadow-xl">
                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div>
                            <label htmlFor="nickname" className="block text-sm font-medium text-gray-300">Nickname</label>
                            <input
                                id="nickname"
                                type="text"
                                value={nickname}
                                onChange={(e) => setNickname(e.target.value)}
                                placeholder="Your cool name"
                                className="mt-1 w-full p-3 bg-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                            />
                        </div>
                        <button type="submit" className="w-full p-3 bg-blue-600 rounded-md font-bold hover:bg-blue-700 transition disabled:bg-gray-600" disabled={!nickname.trim()}>
                            Enter Chat
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};

export default function App() {
    const [user, setUser] = useState(null);
    const [screen, setScreen] = useState('login'); // 'login', 'rooms', 'chat'
    const [roomInfo, setRoomInfo] = useState(null); // { id, name, key }

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            if (currentUser) {
                // User is signed in. Check if they have a nickname stored locally
                const storedNickname = localStorage.getItem('chat-nickname');
                if(storedNickname) {
                    setUser({ uid: currentUser.uid, nickname: storedNickname });
                    setScreen('rooms');
                } else {
                    // Stay on login screen if no nickname is set
                    setUser({ uid: currentUser.uid, nickname: null });
                    setScreen('login');
                }
            } else {
                 // User is signed out. Attempt to sign in.
                 try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(auth, initialAuthToken);
                    } else {
                        await signInAnonymously(auth);
                    }
                } catch (error) {
                    console.error("Error signing in:", error);
                }
            }
        });
        return () => unsubscribe();
    }, []);

    const handleLogin = (nickname) => {
        localStorage.setItem('chat-nickname', nickname);
        setUser(prevUser => ({ ...prevUser, nickname }));
        setScreen('rooms');
    };

    const handleCreateRoom = async (roomName) => {
        // Generate a random key. This is the secret!
        const secretKey = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        
        const roomsPath = `/artifacts/${appId}/public/data/chatRooms`;
        const newRoomRef = doc(collection(db, roomsPath));

        await setDoc(newRoomRef, {
            name: roomName,
            createdAt: serverTimestamp()
        });
        
        setRoomInfo({ id: newRoomRef.id, name: roomName, key: secretKey });
        setScreen('chat');
    };
    
    // In handleJoinRoom, we don't need to check Firestore for the room name.
    // The user experience is better if we just assume the ID/key is correct
    // and let them into the (potentially empty or non-existent) chat.
    // The encrypted messages provide the security.
    const handleJoinRoom = async (joinData) => {
        setRoomInfo({ id: joinData.id, name: `Room: ${joinData.id}`, key: joinData.key });
        setScreen('chat');
    };

    const handleLeaveRoom = () => {
        setRoomInfo(null);
        setScreen('rooms');
    };


    if (!user) {
        return <div className="bg-gray-900 h-screen flex items-center justify-center text-white">Loading...</div>;
    }

    if (screen === 'login') {
        return <LoginScreen onLogin={handleLogin} />;
    }

    if (screen === 'rooms') {
        return <RoomSelectionScreen onCreate={handleCreateRoom} onJoin={handleJoinRoom} />;
    }

    if (screen === 'chat') {
        return <ChatRoomScreen user={user} roomInfo={roomInfo} onLeave={handleLeaveRoom} />;
    }

    return null;
}

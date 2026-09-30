//
//  AgentApp.swift
//  Agent
//
//  Created by Lena Armijo on 9/4/26.
//

import SwiftUI

import Foundation

struct Exception: Error, LocalizedError {
    let errorDescription: String?
}

extension Optional where Wrapped == String {
    var nilIfEmpty: String? {
        guard let self, !self.isEmpty else { return nil }
        return self
    }
}

enum Game: String, CaseIterable, Identifiable {
    case city = "Guess the City"
    case landmark = "Guess the Landmark"

    var id: Self { self }
}

@Observable
final class AppViewModel {
    let rein = Rein()

    var systemPrompt = ""
    var userPrompt = ""

    let systemInstruction = "System prompt…"
    let userInstruction = "Type your guess…"

    var selectedGame: Game = .city

    var errMsg = ""
    var showError = false

    var conversation: [Chat] = []

    var isStreaming = false
    var hasStartedGame = false


    private var gameInitializationPrompt: String {
        switch selectedGame {

        case .city:
            return """
            You are running a Guess the City game.

            At the beginning of this game, choose exactly one mystery city.
            Keep that exact same mystery city fixed throughout the entire
            conversation. Never change the mystery city after choosing it.

            Do not initially reveal the city's name.

            Begin by giving the user a useful clue about the mystery city.

            Treat subsequent user messages as guesses or questions about the
            same mystery city. When a guess is incorrect, do not reveal the
            answer. Instead, tell the user the guess is incorrect and provide
            another useful clue.

            When the user correctly guesses the city, congratulate them,
            reveal the city's name, provide its latitude and longitude, and
            ask whether they would like to play again.
            """

        case .landmark:
            return """
            You are running a Guess the Landmark game.

            At the beginning of this game, choose exactly one famous mystery
            landmark. Keep that exact same landmark fixed throughout the
            entire conversation. Never change the mystery landmark after
            choosing it.

            Do not initially reveal the landmark's name.

            Begin by giving the user a useful clue based on the landmark's
            appearance, history, location, or significance.

            Treat subsequent user messages as guesses or questions about the
            same mystery landmark. When a guess is incorrect, do not reveal
            the answer. Instead, provide another useful clue.

            When the user correctly identifies the landmark, congratulate
            them, reveal its name and location, and ask whether they would
            like to play again.
            """
        }
    }


    var sendDisabled: Bool {
        let system =
            systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)

        let user =
            userPrompt.trimmingCharacters(in: .whitespacesAndNewlines)

        return isStreaming || (system.isEmpty && user.isEmpty)
    }


    func startGame() async {
        guard !isStreaming else {
            return
        }

        isStreaming = true

        let initialization = Message(
            role: "system",
            content: gameInitializationPrompt
        )

        let completion = Chat(
            role: "assistant",
            content: "",
            timestamp: ""
        )

        conversation.append(completion)

        await rein.llmPrompt(
            [initialization],
            completion: completion,
            errMsg: Bindable(self).errMsg
        )

        isStreaming = false
        hasStartedGame = true
        showError = !errMsg.isEmpty
    }


    func send() async {
        guard !isStreaming else {
            return
        }

        let trimmedSystem =
            systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)

        let trimmedUser =
            userPrompt.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedSystem.isEmpty || !trimmedUser.isEmpty else {
            return
        }

        var messages: [Message] = []

        if !trimmedSystem.isEmpty {
            messages.append(
                Message(
                    role: "system",
                    content: trimmedSystem
                )
            )

            conversation.append(
                Chat(
                    role: "system",
                    content: trimmedSystem
                )
            )
        }

        if !trimmedUser.isEmpty {
            messages.append(
                Message(
                    role: "user",
                    content: trimmedUser
                )
            )

            conversation.append(
                Chat(
                    role: "user",
                    content: trimmedUser
                )
            )
        }

        systemPrompt = ""
        userPrompt = ""

        let completion = Chat(
            role: "assistant",
            content: "",
            timestamp: ""
        )

        conversation.append(completion)

        isStreaming = true

        await rein.llmPrompt(
            messages,
            completion: completion,
            errMsg: Bindable(self).errMsg
        )

        isStreaming = false
        showError = !errMsg.isEmpty
    }


    func clear() async {
        guard !isStreaming else {
            return
        }

        let success = await rein.llmClear(
            errMsg: Bindable(self).errMsg
        )

        if success {
            conversation.removeAll()
            systemPrompt = ""
            userPrompt = ""
            hasStartedGame = false

            await startGame()
        }

        showError = !errMsg.isEmpty
    }


    func switchGame(to newGame: Game) async {
        guard !isStreaming else {
            return
        }

        guard newGame != selectedGame else {
            return
        }

        let success = await rein.llmClear(
            errMsg: Bindable(self).errMsg
        )

        guard success else {
            showError = !errMsg.isEmpty
            return
        }

        conversation.removeAll()
        systemPrompt = ""
        userPrompt = ""

        selectedGame = newGame
        hasStartedGame = false

        await startGame()
    }
}


@main
struct AgentApp: App {
    let vm = AppViewModel()
    
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ContentView()
                    .environment(vm)
            }
        }
    }
}

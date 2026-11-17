//
//  AgentApp.swift
//  Agent
//
//  Created by Lena Armijo on 9/4/26.
//


import SwiftUI
import MapKit
import Observation

struct Exception: Error, LocalizedError {
    let errorDescription: String?
}

extension Optional where Wrapped == String {
    var nilIfEmpty: String? {
        guard let self, !self.isEmpty else { return nil }
        return self
    }
}

@Observable
final class AppViewModel {
    let rein = Rein()

    var message = ""
    let instruction = "Enter a guess or ask for a hint…"
    var selectedRole = "user"

    var errMsg = ""
    var showOk = false
    var getSignedin = false
    @ObservationIgnored var signinCompletion: (() async -> Void)?
    var showError = false

    var conversation: [Chat] = []
    var currentHint = ""
    var isBusy = false
    var initialized = false
    var clearUncertain = false

    var cameraPosition: MapCameraPosition = .automatic
    var visibleSpan = MKCoordinateSpan(
        latitudeDelta: 0.15,
        longitudeDelta: 0.15
    )

    var mapReady = false
    var mapPresented = false
    var pendingMove: CLLocationCoordinate2D?
    var generation = 0

    @ObservationIgnored var toolOutcomes: [String: String] = [:]

    
    private let gamePrompt = """
    You are hosting Mystery City.

    GAME RULES:
    1. Secretly select one real city and keep it unchanged
       until the player starts a new game.
    2. Give a useful first hint without naming the city.
    3. Let the player guess the city through conversation.
    4. Provide progressively more helpful hints for
       incorrect guesses.
    5. Never reveal the secret city before the player
       guesses correctly or explicitly gives up.

    WHEN THE PLAYER GUESSES CORRECTLY:
    1. Congratulate the player and reveal the city's name.
    2. Determine the latitude and longitude of the
       secret city's geographic center.
    3. Call get_auth to obtain an authorization ticket.
    4. Call move_map with the city's latitude, longitude,
       and authorization ticket.
    5. The map MUST automatically move to the correct
       city without the player asking to move it.
    6. Do not choose another city until the player
       starts a new game.

    WHEN THE PLAYER GUESSES INCORRECTLY:
    1. Do not call move_map.
    2. Keep the map at its current position.
    3. Provide another hint.

    WHEN THE PLAYER STARTS A NEW GAME:
    1. Choose a different city from the previous game.
    2. Keep the new city's identity secret.
    3. Provide a new first hint.
    4. Do not move the map automatically.

    MAP TOOL RULES:
    - Use move_map when the player guesses correctly.
    - Also use move_map when the player explicitly asks
      to move or show a map location.
    - Always obtain authorization using get_auth before
      calling move_map.
    - Never reveal authorization tickets in chat.
    - Do not call move_map for incorrect guesses.

    Keep responses concise and engaging.
    """

    func acceptLocation(_ location: Location) {
        guard !mapReady else { return }

        let coordinate = CLLocationCoordinate2D(
            latitude: location.lat,
            longitude: location.lon
        )

        cameraPosition = .region(
            MKCoordinateRegion(
                center: coordinate,
                span: visibleSpan
            )
        )

        mapReady = true
    }

    func applyMapMove(latitude: Double, longitude: Double) -> String {
        guard latitude.isFinite,
              longitude.isFinite,
              (-90...90).contains(latitude),
              (-180...180).contains(longitude) else {
            return "400 Invalid map coordinates"
        }

        guard mapReady else {
            return "409 Current location not yet available"
        }

        let coordinate = CLLocationCoordinate2D(
            latitude: latitude,
            longitude: longitude
        )

        cameraPosition = .region(
            MKCoordinateRegion(
                center: coordinate,
                span: visibleSpan
            )
        )

        return "200 Map camera centered at latitude \(latitude), longitude \(longitude)"
    }

    func initializeRound() async {
        guard !isBusy, !initialized, !clearUncertain else { return }

        isBusy = true
        errMsg = ""

        let epoch = generation
        let candidate = Chat(
            role: "assistant",
            content: "",
            timestamp: ""
        )

        await rein.llmTools(
            [
                Message(role: "system", content: gamePrompt),
                Message(
                    role: "user",
                    content: "Choose the secret city and give me my first hint. Do not name the city."
                )
            ],
            completion: candidate,
            errMsg: Bindable(self).errMsg
        )
        print("=== INITIAL HINT DEBUG ===")
        print("Response:", String(reflecting: candidate.content))
        print("Error:", errMsg)
        print("Response length:", candidate.content.count)
        print("==========================")

        if epoch == generation &&
           errMsg.isEmpty &&
           !candidate.content.trimmingCharacters(
                in: .whitespacesAndNewlines
           ).isEmpty {

            currentHint = candidate.content
            initialized = true

        } else if epoch == generation {
            if errMsg.isEmpty {
                errMsg = "No initial hint received. Tap Send to retry."
            }
            showError = true
        }

        isBusy = false
    }

    func sendMessage() async {
        guard !isBusy, !clearUncertain else { return }

        guard initialized else {
            await initializeRound()
            return
        }

        let content = message.trimmingCharacters(
            in: .whitespacesAndNewlines
        )

        guard !content.isEmpty else { return }

        let role = selectedRole
        message = ""
        isBusy = true
        errMsg = ""

        let epoch = generation
        let candidate = Chat(
            role: "assistant",
            content: "",
            timestamp: ""
        )

        await rein.llmTools(
            [Message(role: role, content: content)],
            completion: candidate,
            errMsg: Bindable(self).errMsg
        )

        guard epoch == generation else {
            isBusy = false
            return
        }

        if errMsg.isEmpty &&
           !candidate.content.trimmingCharacters(
                in: .whitespacesAndNewlines
           ).isEmpty {

            currentHint = candidate.content
            conversation.append(
                Chat(role: role, content: content)
            )
            conversation.append(candidate)

        } else {
            message = content

            if errMsg.isEmpty {
                errMsg = "No completed response received."
            }

            showError = true
        }

        isBusy = false
    }

    func clearRound() async {
        guard !isBusy else { return }

        isBusy = true
        errMsg = ""

        do {
            try await rein.llmClear()

            generation += 1
            initialized = false
            clearUncertain = false
            currentHint = ""
            conversation.removeAll()
            message = ""
            toolOutcomes.removeAll()
            pendingMove = nil

            if let location = LocManagerViewModel.shared.location {
                cameraPosition = .region(
                    MKCoordinateRegion(
                        center: CLLocationCoordinate2D(
                            latitude: location.lat,
                            longitude: location.lon
                        ),
                        span: visibleSpan
                    )
                )
            }

            isBusy = false
            await initializeRound()

        } catch {
            errMsg = """
            Clear was not confirmed: \(error.localizedDescription).
            Retry Clear before starting another round.
            """

            clearUncertain = true
            showError = true
            isBusy = false
        }
    }
}

@main
struct AgentApp: App {
    let vm = AppViewModel()

    init() {
        LocManager.shared.startUpdates()
        Ticket.shared.vm = vm

        Task { [vm] in
            await Ticket.shared.open(
                errMsg: Bindable(vm).errMsg,
                showOk: Bindable(vm).showOk
            )
            
            if vm.showOk {
                    vm.showOk = false
                    vm.errMsg = ""
                }
        }
    }

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                ContentView()
                    .environment(vm)
            }
        }
    }
}

//
//  ContentView.swift
//  Agent
//
//  Created by Lena Armijo on 9/4/26.
//

import SwiftUI
import MapKit

struct ContentView: View {
    @Environment(AppViewModel.self) private var vm
    @FocusState private var messageInFocus: Bool
    @State private var location = LocManagerViewModel.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = vm

        VStack(spacing: 10) {
            Group {
                if vm.mapReady {
                    Map(position: $model.cameraPosition)
                        .onMapCameraChange(frequency: .onEnd) { context in
                            let span = context.region.span

                            if span.latitudeDelta > 0 &&
                               span.longitudeDelta > 0 {
                                vm.visibleSpan = span
                            }
                        }
                        .onAppear {
                            vm.mapPresented = true
                        }
                } else {
                    VStack(spacing: 12) {
                        ProgressView()

                        Text(
                            "Waiting for your current location. You can still play while the map is unavailable."
                        )
                        .font(.footnote)
                        .multilineTextAlignment(.center)

                        Button("Retry Location") {
                            LocManager.shared.startUpdates()
                        }

                        Text(
                            "If location access was denied, enable it in iOS Settings."
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .frame(
                        maxWidth: .infinity,
                        maxHeight: .infinity
                    )
                }
            }
            .frame(maxHeight: .infinity)

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Hint")
                        .font(.headline)

                    Text(
                        vm.currentHint.isEmpty
                        ? "Ready for your guess. Your first hint is loading…"
                        : vm.currentHint
                    )
                    .frame(
                        maxWidth: .infinity,
                        alignment: .leading
                    )
                    .textSelection(.enabled)
                }
                .padding(12)
            }
            .frame(height: 155)

            HStack {
                Picker("Role", selection: $model.selectedRole) {
                    Text("User").tag("user")
                    Text("System").tag("system")
                }
                .pickerStyle(.segmented)

                Button("Clear") {
                    Task {
                        await vm.clearRound()
                    }
                }
                .disabled(vm.isBusy)
            }

            HStack {
                TextField(
                    vm.instruction,
                    text: $model.message
                )
                .textFieldStyle(.roundedBorder)
                .focused($messageInFocus)
                .submitLabel(.send)
                .onSubmit {
                    Task {
                        await vm.sendMessage()
                    }
                }

                Button {
                    Task {
                        await vm.sendMessage()
                    }
                } label: {
                    if vm.isBusy {
                        ProgressView()
                    } else {
                        Image(systemName: "paperplane.fill")
                    }
                }
                .disabled(
                    vm.isBusy ||
                    (
                        vm.initialized &&
                        vm.message.trimmingCharacters(
                            in: .whitespacesAndNewlines
                        ).isEmpty
                    ) ||
                    vm.clearUncertain
                )
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 8)
        .navigationTitle("Mystery City")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let fix = location.location {
                vm.acceptLocation(fix)
            }

            if !vm.initialized &&
               !vm.isBusy &&
               !vm.clearUncertain {
                Task {
                    await vm.initializeRound()
                }
            }
        }
        .onChange(of: location.location?.lat) { _, _ in
            if let fix = location.location {
                vm.acceptLocation(fix)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && !vm.mapReady {
                LocManager.shared.startUpdates()
            }
        }
        .alert(
            vm.showError ? "LLM Error" : "Advisory",
            isPresented: Binding(
                get: {
                    vm.showError || vm.showOk
                },
                set: { _ in
                    vm.showError = false
                    vm.showOk = false
                }
            )
        ) {
            Button("OK") {
                vm.errMsg = ""
            }
        } message: {
            Text(vm.errMsg)
        }
        .sheet(isPresented: $model.getSignedin) {
            SigninView(
                isPresenting: $model.getSignedin
            )
            .presentationDetents([.fraction(0.25)])
            .presentationDragIndicator(.hidden)
            .interactiveDismissDisabled()
        }
    }
}

//
//  LocManager.swift
//  Agent
//
//  Created by Lena Armijo on 10/7/26.
//
import MapKit
import Observation

struct Location: Decodable {
    var lat: CLLocationDegrees
    var lon: CLLocationDegrees
}

@Observable
final class LocManagerViewModel {
    static let shared = LocManagerViewModel()

    private init() {}

    private(set) var location: Location? = nil

    func setLocation(
        lat: CLLocationDegrees,
        lon: CLLocationDegrees
    ) {
        guard lat.isFinite,
              lon.isFinite,
              (-90...90).contains(lat),
              (-180...180).contains(lon) else {
            return
        }

        location = Location(lat: lat, lon: lon)
    }
}

final class LocManager: NSObject, CLLocationManagerDelegate {
    static let shared = LocManager()

    private let locManager = CLLocationManager()
    private var updating = false

    override private init() {
        super.init()

        locManager.desiredAccuracy = kCLLocationAccuracyBest
        locManager.delegate = self
    }

    func startUpdates() {
        guard !updating else { return }

        updating = true

        if locManager.authorizationStatus == .notDetermined {
            locManager.requestWhenInUseAuthorization()
        }

        Task {
            do {
                for try await update in CLLocationUpdate.liveUpdates() {
                    if let loc = update.location {
                        LocManagerViewModel.shared.setLocation(
                            lat: loc.coordinate.latitude,
                            lon: loc.coordinate.longitude
                        )
                    }
                }
            } catch {
                print(error.localizedDescription)
            }

            self.updating = false
        }
    }
}

